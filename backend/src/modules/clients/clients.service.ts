/**
 * Clients Service — admin side of the lean client-management layer.
 *
 * "Add client -> run the pipeline -> Day-1 report" (the onboarding flow
 * described on the call): `createProject()` creates the Project under a
 * Client and starts `runDayOnePipeline()` in the background — the HTTP call
 * returns as soon as the row exists, not after every stage completes.
 * Progress is tracked on `Project.onboardingStatus`/`onboardingStep`, polled
 * by the admin dashboard rather than held open on one long request.
 *
 * Orchestrates (all already-built, this module invents no new audit logic):
 * technical-audit (queued, polled via PipelineQueueService) -> digital-
 * presence discover (queued, polled via PresenceDiscovery.status) ->
 * tech-stack scan (sync) -> competitors discover (sync, skipped when the
 * project has no seeded competitors) -> gap-analysis sync (sync) ->
 * strategy build (sync) -> reporting generate (sync, the "Day-1 report").
 *
 * A stage failing logs a warning and the pipeline moves on where the next
 * stage can still produce something real (e.g. gap-analysis sync degrades
 * gracefully per-source already); `onboardingStatus` only ever reads
 * "failed" when the run could not produce a usable report at all.
 *
 * @module clients.service
 */

import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcryptjs from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import { PresenceService } from '../digital-presence/presence.service';
import { TechStackService } from '../tech-stack/tech-stack.service';
import { CompetitorsService } from '../competitors/competitors.service';
import { GapAnalysisService } from '../gap-analysis/gap-analysis.service';
import { StrategyService } from '../strategy/strategy.service';
import { ReportingService } from '../reporting/reporting.service';
import { IntakeService } from '../intake/intake.service';
import { AeoAuditService } from '../aeo-audit/aeo-audit.service';
import { KeywordResearchService } from '../keyword-research/keyword-research.service';
import { GrowthExecutionService } from '../growth-execution/growth-execution.service';
import { EntityAuditService } from '../entity-audit/entity-audit.service';
import { BacklinksService } from '../backlinks/backlinks.service';
import { FindingsService } from '../findings/findings.service';
import { DeliveryPlanService } from '../delivery-plan/delivery-plan.service';
import { ActivityService } from '../activity/activity.service';
import type { UserType } from '../auth/auth.types';
import type {
  ClientDto,
  ClientDetailDto,
  ClientOverviewDto,
  ClientProjectSummaryDto,
  ClientLoginCreatedDto,
  ClientMessageDto,
  OnboardingWizardState,
} from './clients.types';
import type { CreateClientDto, UpdateClientDto, CreateClientProjectDto, CreateClientLoginDto } from './dto/clients.dto';

const BCRYPT_ROUNDS = 10;
/** Bounded wait for a queued stage before the pipeline moves on and marks that
 * stage's data absent, not the whole run failed. A full crawl (technical-audit,
 * page budget up to 100 under the fetcher's per-domain rate limit) can
 * legitimately take several minutes — this must comfortably exceed that, or
 * the pipeline moves on to report generation before the audit row exists. */
const STAGE_POLL_TIMEOUT_MS = 480_000;
const STAGE_POLL_INTERVAL_MS = 2000;

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly pipelineQueue: PipelineQueueService,
    private readonly presence: PresenceService,
    private readonly techStack: TechStackService,
    private readonly competitors: CompetitorsService,
    private readonly gapAnalysis: GapAnalysisService,
    private readonly strategy: StrategyService,
    private readonly reporting: ReportingService,
    private readonly intake: IntakeService,
    private readonly aeoAudit: AeoAuditService,
    private readonly keywordResearch: KeywordResearchService,
    private readonly growthExecution: GrowthExecutionService,
    private readonly entityAudit: EntityAuditService,
    private readonly backlinksService: BacklinksService,
    private readonly findingsService: FindingsService,
    /**
     * §3.4's delivery columns (delivery lead, plan progress, waiting on
     * client) reuse DeliveryPlanService's own definitions rather than
     * re-deriving them here, so the portfolio list and the per-project plan /
     * action screens can never disagree.
     */
    private readonly deliveryPlan: DeliveryPlanService,
    /**
     * C1 (`docs/analysis/client-portal.md` §15/§33) — the shared admin-action
     * audit log. `record()` writes the "waive Google-connect gate" event;
     * nothing else in this module writes to it (that's out of scope for C1).
     */
    private readonly activity: ActivityService,
  ) {}

  // ─── Client CRUD ───────────────────────────────────────────────────

  async createClient(dto: CreateClientDto): Promise<ClientDto> {
    const row = await this.prisma.client.create({
      data: {
        name: dto.name,
        contactName: dto.contactName ?? null,
        contactEmail: dto.contactEmail ?? null,
        ownerUserId: dto.ownerUserId ?? null,
        notes: dto.notes ?? null,
      },
    });
    this.logger.log(`Client created: ${row.id} (${row.name})`);
    return this.toClientDto(row);
  }

  /** The admin clients list — one row per client with the "progress kinda stuff" the call asked for. */
  async listClients(): Promise<{ clients: ClientOverviewDto[] }> {
    const rows = await this.prisma.client.findMany({ orderBy: { createdAt: 'desc' } });
    const clients = await Promise.all(rows.map((r) => this.toOverviewDto(r)));
    return { clients };
  }

  async getClient(clientId: string): Promise<ClientDetailDto> {
    const row = await this.requireClient(clientId);
    const projects = await this.prisma.project.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    const summaries = await Promise.all(projects.map((p) => this.toProjectSummary(p)));
    return { ...this.toClientDto(row), projects: summaries };
  }

  async updateClient(clientId: string, dto: UpdateClientDto): Promise<ClientDto> {
    await this.requireClient(clientId);
    const row = await this.prisma.client.update({
      where: { id: clientId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.contactName !== undefined ? { contactName: dto.contactName } : {}),
        ...(dto.contactEmail !== undefined ? { contactEmail: dto.contactEmail } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.ownerUserId !== undefined ? { ownerUserId: dto.ownerUserId } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    return this.toClientDto(row);
  }

  // ─── Onboarding: "add client -> run the pipeline" ─────────────────

  /**
   * Create a Project under this client and start the Day-1 pipeline in the
   * background. Returns immediately with `onboardingStatus: "running"` —
   * poll `GET /clients/:clientId/projects/:projectId` for progress.
   */
  async createProject(clientId: string, dto: CreateClientProjectDto): Promise<ClientProjectSummaryDto> {
    await this.requireClient(clientId);

    const existing = await this.prisma.project.findUnique({ where: { domain: dto.domain } });
    if (existing) {
      throw new ConflictException(`A project for domain "${dto.domain}" already exists (project ${existing.id}).`);
    }

    const project = await this.prisma.project.create({
      data: { name: dto.name, domain: dto.domain, clientId, onboardingStatus: 'running', onboardingStep: 'enrichment' },
    });

    // Deliberately not awaited — the HTTP response must not hold open for
    // the ~1-3 minutes the full pipeline can take. Errors are caught INSIDE
    // runDayOnePipeline and written to the row, never thrown into the void.
    void this
      .runDayOnePipeline(project.id, {
        runAeoAudit: dto.runAeoAudit ?? false,
        runKeywordResearch: dto.runKeywordResearch ?? false,
        runGrowthExecution: dto.runGrowthExecution ?? false,
        runBacklinksRefresh: dto.runBacklinksRefresh ?? false,
      })
      .catch((err) => {
        this.logger.error(`Day-1 pipeline crashed outside its own guard for ${project.id}: ${(err as Error).message}`);
      });

    return this.toProjectSummary(project);
  }

  // ─── Onboarding wizard gate (C1 — client-portal.md §15/§16) ────────

  /**
   * Admin-only "waive Google-connect for this project" action (§15). Sets the
   * per-project onboarding-wizard gate straight to `waived` — a real, visibly
   * distinct terminal state, never silently rendered as `done`  — and writes
   * an audit event recording who waived it, when, and for which client/project
   * (§33). Idempotent: waiving an already-waived project just re-records the
   * event (useful as a paper trail if it's waived more than once) rather than
   * rejecting the call.
   *
   * The actual sequential onboarding wizard UI that reads/writes the other
   * states (`confirming-details`, `connecting-gsc`, `connecting-ga4`, `done`)
   * is Phase C2, not built here — this method only needs to know how to reach
   * the terminal `waived` state and log it.
   */
  async waiveOnboardingWizard(
    clientId: string,
    projectId: string,
    actorUserId: string,
    reason?: string,
  ): Promise<ClientProjectSummaryDto> {
    await this.requireClient(clientId);
    const project = await this.requireProjectOfClient(clientId, projectId);

    const previousState = project.onboardingWizardState;
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { onboardingWizardState: 'waived' satisfies OnboardingWizardState },
    });

    await this.activity.record({
      actor: { type: 'user', id: actorUserId },
      action: 'waived',
      resource: { type: 'project', id: projectId },
      clientId,
      projectId,
      summary: `Waived the Google-connect onboarding gate for project ${projectId}${reason ? `: ${reason}` : ''}`,
      changes: { onboardingWizardState: { before: previousState, after: 'waived' } },
      origin: 'api',
      // Not client-visible: the client-facing surface for this state lives in
      // C2's wizard UI, not the operator audit trail.
      clientVisible: false,
    });

    this.logger.log(`Onboarding wizard gate waived for project ${projectId} (client ${clientId}) by ${actorUserId}`);
    return this.toProjectSummary(updated);
  }

  /** Reads the current onboarding-wizard gate state for one project of this client. */
  async getOnboardingWizardState(clientId: string, projectId: string): Promise<{ projectId: string; state: OnboardingWizardState }> {
    await this.requireClient(clientId);
    const project = await this.requireProjectOfClient(clientId, projectId);
    return { projectId, state: project.onboardingWizardState as OnboardingWizardState };
  }

  /** Loads a Project and 404s unless it exists AND belongs to this client — mirrors postMessage's ownership check. */
  private async requireProjectOfClient(clientId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.clientId !== clientId) {
      throw new NotFoundException(`Project ${projectId} not found for client ${clientId}`);
    }
    return project;
  }

  private async runDayOnePipeline(
    projectId: string,
    opts: {
      runAeoAudit: boolean;
      runKeywordResearch: boolean;
      runGrowthExecution: boolean;
      runBacklinksRefresh: boolean;
    },
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return;
    const targetUrl = /^https?:\/\//i.test(project.domain) ? project.domain : `https://${project.domain}`;

    const setStep = (step: string) => this.prisma.project.update({ where: { id: projectId }, data: { onboardingStep: step } });
    const warn = (stage: string, err: unknown) =>
      this.logger.warn(`Day-1 pipeline: ${stage} failed for ${projectId} — continuing: ${(err as Error).message}`);

    // 0. Enrichment — crawl the homepage for category + named competitors
    // (same extraction intake/subject does) so the competitors/gap-analysis
    // stages below have real seed data on day one instead of running empty.
    await setStep('enrichment');
    let brandName = project.name;
    try {
      const enrichment = await this.intake.enrichExistingProject(projectId, project.domain, { company: project.name });
      if (enrichment.company) brandName = enrichment.company;
    } catch (err) {
      warn('enrichment', err);
    }

    // 0b. Entity audit — free (no external spend), always on: create one
    // "brand" entity for the client itself and run a schema-check against
    // its homepage. This is what feeds the "Entity clarity" score dimension
    // (25 of 100 points) — without it, that dimension is structurally stuck
    // at 0 regardless of how good the site's schema actually is.
    await setStep('entity-audit');
    let entityId: string | null = null;
    try {
      const entity = await this.entityAudit.createEntity(projectId, brandName, 'brand');
      entityId = entity.id;
      await this.entityAudit.runSchemaCheck(projectId, entity.id, targetUrl);
    } catch (err) {
      warn('entity-audit', err);
    }

    // 1. Technical audit — queued, polled.
    await setStep('technical-audit');
    try {
      const { jobId } = await this.pipelineQueue.enqueue('technical-audit', { targetUrl, projectId, triggeredBy: 'onboarding' });
      const finished = await this.pollJob(jobId);
      if (!finished) {
        this.logger.warn(
          `Day-1 pipeline: technical-audit for ${projectId} did not finish within ${STAGE_POLL_TIMEOUT_MS}ms — continuing without it (job ${jobId} may still complete in the background).`,
        );
      }
    } catch (err) {
      warn('technical-audit', err);
    }

    // 2. Digital presence discovery — queued, polled.
    await setStep('digital-presence');
    try {
      const run = await this.presence.discover(projectId, false);
      const finished = await this.pollDiscoveryRun(run.id);
      if (!finished) {
        this.logger.warn(
          `Day-1 pipeline: digital-presence for ${projectId} did not finish within ${STAGE_POLL_TIMEOUT_MS}ms — continuing without it (run ${run.id} may still complete in the background).`,
        );
      }
    } catch (err) {
      warn('digital-presence', err);
    }

    // 2b. Link discovered accounts as entity platform-records — free, always
    // on. This is the other half of the "Authority signal" score dimension
    // (the entity-audit stage above only covers the schema-check half); a
    // confirmed/unverified company account IS a platform record, it just
    // has to be told to entity-audit, which digital-presence doesn't do on
    // its own since the two modules don't share a write path.
    if (entityId) {
      const id = entityId;
      try {
        const inventory = await this.presence.inventory(projectId);
        const companyAccounts = inventory.accounts.filter((a) => a.entity === 'company' && a.state !== 'candidate');
        for (const account of companyAccounts) {
          try {
            await this.entityAudit.createPlatformRecord(
              projectId,
              id,
              account.platform,
              account.handle ?? undefined,
              undefined,
              account.url,
              account.nameConsistency === 'not-checked' ? 'not-checked' : account.nameConsistency,
              false,
            );
          } catch (err) {
            warn(`platform-record:${account.platform}`, err);
          }
        }
      } catch (err) {
        warn('platform-records', err);
      }
    }

    // 3. Tech stack scan — synchronous.
    await setStep('tech-stack');
    try {
      await this.techStack.scanDomain(projectId);
    } catch (err) {
      warn('tech-stack', err);
    }

    // 4. Competitors — synchronous; only meaningful once Project.competitors
    // is seeded (intake or a manual PATCH), so an empty result here is
    // normal on day one, not a failure.
    await setStep('competitors');
    try {
      await this.competitors.discover(projectId, {});
    } catch (err) {
      warn('competitors', err);
    }

    // 5. Gap analysis — consolidates everything above.
    await setStep('gap-analysis');
    try {
      await this.gapAnalysis.sync(projectId);
    } catch (err) {
      warn('gap-analysis', err);
    }

    // 6. Strategy — the ranked action plan.
    await setStep('strategy');
    try {
      await this.strategy.buildActionPlan(projectId);
    } catch (err) {
      warn('strategy', err);
    }

    // 6a. Findings copy — free (uses the shared LLM service, same OpenRouter
    // key as everything else), always on: turns the highest-priority open
    // gaps into plain-language what/why/fix copy. Without this, the report's
    // narrative sections fall back to raw technical rows like "js-render:
    // fail" instead of a sentence a marketer would actually read.
    await setStep('findings');
    try {
      await this.findingsService.generate(projectId, { limit: 5 });
    } catch (err) {
      warn('findings', err);
    }

    // 6b. Keyword research — opt-in (checkbox on Add Client), costs DataForSEO
    // credits per call. Seeded from the enrichment category since there are
    // no real seed keywords yet on day one; skipped if enrichment found none.
    if (opts.runKeywordResearch) {
      await setStep('keyword-research');
      try {
        const fresh = await this.prisma.project.findUnique({ where: { id: projectId } });
        const seeds = Array.from(new Set([fresh?.category, project.name].filter((s): s is string => !!s)));
        if (seeds.length > 0) {
          await this.keywordResearch.research(projectId, { keywords: seeds.slice(0, 5) });
        } else {
          warn('keyword-research', new Error('no seed keywords — enrichment found no category'));
        }
      } catch (err) {
        warn('keyword-research', err);
      }
    }

    // 6c. Growth execution — opt-in, generates asset briefs (deterministic
    // templates, no LLM spend unless useLlm) from the gap-analysis/strategy
    // output above.
    if (opts.runGrowthExecution) {
      await setStep('growth-execution');
      try {
        await this.growthExecution.createAssets(projectId, {});
      } catch (err) {
        warn('growth-execution', err);
      }
    }

    // 6d. AEO audit — opt-in, real Cloro/LLM spend per run and can take
    // several minutes (up to hundreds of surface prompts). Fired and NOT
    // awaited to completion — it tracks its own status via GET
    // /aeo/audits/:auditId and must not hold up the Day-1 report.
    if (opts.runAeoAudit) {
      await setStep('aeo-audit');
      try {
        await this.aeoAudit.runFullAsync(projectId, {});
      } catch (err) {
        warn('aeo-audit', err);
      }
    }

    // 6e. Backlinks — opt-in, costs DataForSEO credits per call.
    if (opts.runBacklinksRefresh) {
      await setStep('backlinks');
      try {
        await this.backlinksService.refresh(projectId, {});
      } catch (err) {
        warn('backlinks', err);
      }
    }

    // 7. Report — the actual Day-1 deliverable. If THIS fails, the pipeline
    // genuinely failed: there is nothing to show the client.
    await setStep('report');
    try {
      await this.reporting.generateReport(projectId, targetUrl, `${project.name} — Day 1 Audit`);
      await this.prisma.project.update({ where: { id: projectId }, data: { onboardingStatus: 'completed', onboardingStep: null, onboardingError: null } });
      this.logger.log(`Day-1 pipeline completed for ${projectId}`);
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.project.update({ where: { id: projectId }, data: { onboardingStatus: 'failed', onboardingStep: 'report', onboardingError: message } });
      this.logger.error(`Day-1 pipeline failed for ${projectId} at report generation: ${message}`);
    }
  }

  /** @returns true if the job reached a terminal state, false if the poll timed out first. */
  private async pollJob(jobId: string): Promise<boolean> {
    const deadline = Date.now() + STAGE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await this.pipelineQueue.getStatus(jobId);
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'not_found') return true;
      await new Promise((r) => setTimeout(r, STAGE_POLL_INTERVAL_MS));
    }
    return false;
  }

  /** @returns true if the discovery run reached a terminal state, false if the poll timed out first. */
  private async pollDiscoveryRun(runId: string): Promise<boolean> {
    const deadline = Date.now() + STAGE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const run = await this.prisma.presenceDiscovery.findUnique({ where: { id: runId }, select: { status: true } });
      if (!run || run.status === 'completed' || run.status === 'failed') return true;
      await new Promise((r) => setTimeout(r, STAGE_POLL_INTERVAL_MS));
    }
    return false;
  }

  // ─── Client login (client-portal credentials) ─────────────────────

  /**
   * @deprecated Not the canonical client-login path as of 2026-09-20 — see
   * `docs/analysis/client-portal.md` §2 and `docs/PLAN.md` §11.0. `client-access`'s
   * `createInvite()` (`POST /clients/:clientId/invites`) is canonical: a single-use,
   * 7-day invite link where the client sets their own password, never a plaintext
   * credential generated server-side and relayed by hand. This method is kept — not
   * removed, still fully functional — as a non-default escape hatch only; no new
   * caller (UI, automation, or another module) should be wired to it. In particular,
   * Phase C2's "auto-email on Day-1 pipeline completion" must use the invite-link
   * flow, not this method.
   *
   * Create a client-portal login for this client. Generates a random
   * temporary password (never emailed or logged in the clear beyond this one
   * response), hashes it the same way operator registration does, and
   * best-effort emails it via Plunk — honestly reporting `emailSent: false`
   * rather than failing the whole call when Plunk is unconfigured, since the
   * login itself was still created either way.
   */
  async createClientLogin(clientId: string, dto: CreateClientLoginDto): Promise<ClientLoginCreatedDto> {
    await this.requireClient(clientId);

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException(`Email already registered: ${dto.email}`);
    }

    const temporaryPassword = randomBytes(12).toString('base64url'); // 16 chars, URL-safe
    const passwordHash = await bcryptjs.hash(temporaryPassword, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name ?? dto.email,
        type: 'client' satisfies UserType,
        clientId,
      },
    });
    this.logger.log(`Client login created: ${user.id} for client ${clientId}`);

    const { sent, error } = await this.sendLoginEmail(dto.email, temporaryPassword);
    return { userId: user.id, email: user.email, temporaryPassword, emailSent: sent, emailError: error };
  }

  private async sendLoginEmail(to: string, temporaryPassword: string): Promise<{ sent: boolean; error: string | null }> {
    const apiKey = this.config.get<string>('PLUNK_SECRET_KEY');
    if (!apiKey) return { sent: false, error: 'PLUNK_SECRET_KEY not configured' };
    try {
      const res = await fetch('https://api.useplunk.com/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          to,
          subject: 'Your Rothenhall client portal access',
          body: `<p>Your login: ${to}</p><p>Temporary password: <strong>${temporaryPassword}</strong></p><p>Please change it after you sign in.</p>`,
        }),
      });
      if (!res.ok) return { sent: false, error: `Plunk returned ${res.status}` };
      return { sent: true, error: null };
    } catch (err) {
      return { sent: false, error: (err as Error).message };
    }
  }

  // ─── Messages ("leave messages", not a ticketing system) ──────────

  async listMessages(clientId: string): Promise<{ messages: ClientMessageDto[] }> {
    await this.requireClient(clientId);
    const rows = await this.prisma.clientMessage.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });
    return { messages: rows.map((r) => this.toMessageDto(r)) };
  }

  /**
   * Posted by an authenticated OPERATOR — authorType is always "operator" here,
   * never trusted from the caller.
   *
   * A supplied `projectId` is checked against THIS client before the row is
   * written (G19/D26). Without that check an operator request — or anything
   * holding an operator token — could file a message under another client's
   * project simply by passing its id, and the message would then surface in
   * that client's portal thread. This mirrors `ClientPortalService.postMessage`
   * exactly, 403 included, so both write paths answer the same way.
   */
  async postMessage(clientId: string, operatorUserId: string, dto: { projectId?: string; body: string }): Promise<ClientMessageDto> {
    await this.requireClient(clientId);
    if (dto.projectId) {
      const owns = await this.prisma.project.findUnique({ where: { id: dto.projectId }, select: { clientId: true } });
      if (!owns || owns.clientId !== clientId) {
        throw new ForbiddenException('That project does not belong to this client');
      }
    }
    const row = await this.prisma.clientMessage.create({
      data: { clientId, projectId: dto.projectId ?? null, authorUserId: operatorUserId, authorType: 'operator', body: dto.body },
    });
    return this.toMessageDto(row);
  }

  private toMessageDto(row: {
    id: string;
    clientId: string;
    projectId: string | null;
    authorUserId: string;
    authorType: string;
    body: string;
    createdAt: Date;
  }): ClientMessageDto {
    return {
      id: row.id,
      clientId: row.clientId,
      projectId: row.projectId,
      authorUserId: row.authorUserId,
      authorType: row.authorType as ClientMessageDto['authorType'],
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private async requireClient(clientId: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);
    return client;
  }

  private toClientDto(row: {
    id: string;
    name: string;
    contactName: string | null;
    contactEmail: string | null;
    status: string;
    ownerUserId: string | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ClientDto {
    return {
      id: row.id,
      name: row.name,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      status: row.status as ClientDto['status'],
      ownerUserId: row.ownerUserId,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async toOverviewDto(row: Parameters<ClientsService['toClientDto']>[0]): Promise<ClientOverviewDto> {
    const projects = await this.prisma.project.findMany({ where: { clientId: row.id }, select: { id: true, onboardingStatus: true } });
    const projectIds = projects.map((p) => p.id);

    let latestScore: number | null = null;
    let latestBand: string | null = null;
    if (projectIds.length > 0) {
      const latestReport = await this.prisma.report.findFirst({
        where: { projectId: { in: projectIds } },
        orderBy: { createdAt: 'desc' },
        select: { scoreTotal: true, scoreBand: true },
      });
      if (latestReport) {
        latestScore = latestReport.scoreTotal;
        latestBand = latestReport.scoreBand;
      }
    }

    const openGapCount =
      projectIds.length > 0
        ? await this.prisma.gap.count({ where: { gapAnalysis: { projectId: { in: projectIds } }, status: 'open' } })
        : 0;

    // §3.4's delivery columns. The most recent RELEASED report is fetched
    // separately from `latestScore` above: that field reports the newest
    // report row for the score readout, whereas "last report" is a delivery
    // fact about what the client has actually been sent, so a draft must not
    // appear here.
    const [deliveryLeadName, planProgress, waitingOnClient, lastReleased] = await Promise.all([
      this.deliveryPlan.getClientDeliveryLeadName(row.id),
      this.deliveryPlan.getClientPlanProgress(row.id),
      this.deliveryPlan.countWaitingOnClient(row.id),
      projectIds.length > 0
        ? this.prisma.report.findFirst({
            where: { projectId: { in: projectIds }, status: 'released', releasedAt: { not: null } },
            orderBy: { releasedAt: 'desc' },
            select: { slug: true, releasedAt: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      ...this.toClientDto(row),
      projectCount: projects.length,
      latestScore,
      latestBand,
      openGapCount,
      hasProjectOnboarding: projects.some((p) => p.onboardingStatus === 'running'),
      deliveryLeadName,
      planProgress: { delivered: planProgress.delivered, committed: planProgress.committed },
      overdueCommitments: planProgress.overdueCommitments,
      waitingOnClient,
      lastReport: lastReleased
        ? { slug: lastReleased.slug, releasedAt: lastReleased.releasedAt?.toISOString() ?? null }
        : null,
    };
  }

  private async toProjectSummary(project: {
    id: string;
    name: string;
    domain: string;
    status: string;
    onboardingStatus: string;
    onboardingStep: string | null;
    onboardingError: string | null;
    onboardingWizardState: string;
    createdAt: Date;
  }): Promise<ClientProjectSummaryDto> {
    const latestReport = await this.prisma.report.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      select: { scoreTotal: true, scoreBand: true, slug: true },
    });
    const analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId: project.id }, select: { id: true } });
    const openGapCount = analysis ? await this.prisma.gap.count({ where: { gapAnalysisId: analysis.id, status: 'open' } }) : 0;

    return {
      id: project.id,
      name: project.name,
      domain: project.domain,
      status: project.status,
      onboardingStatus: project.onboardingStatus as ClientProjectSummaryDto['onboardingStatus'],
      onboardingStep: project.onboardingStep,
      onboardingError: project.onboardingError,
      onboardingWizardState: project.onboardingWizardState as OnboardingWizardState,
      latestScore: latestReport?.scoreTotal ?? null,
      latestBand: latestReport?.scoreBand ?? null,
      latestReportSlug: latestReport?.slug ?? null,
      openGapCount,
      createdAt: project.createdAt.toISOString(),
    };
  }
}
