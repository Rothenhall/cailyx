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

import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
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
import type { UserType } from '../auth/auth.types';
import type {
  ClientDto,
  ClientDetailDto,
  ClientOverviewDto,
  ClientProjectSummaryDto,
  ClientLoginCreatedDto,
  ClientMessageDto,
} from './clients.types';
import type { CreateClientDto, UpdateClientDto, CreateClientProjectDto, CreateClientLoginDto } from './dto/clients.dto';

const BCRYPT_ROUNDS = 10;
/** Bounded wait for a queued stage before the pipeline moves on and marks that stage's data absent, not the whole run failed. */
const STAGE_POLL_TIMEOUT_MS = 120_000;
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
      data: { name: dto.name, domain: dto.domain, clientId, onboardingStatus: 'running', onboardingStep: 'technical-audit' },
    });

    // Deliberately not awaited — the HTTP response must not hold open for
    // the ~1-3 minutes the full pipeline can take. Errors are caught INSIDE
    // runDayOnePipeline and written to the row, never thrown into the void.
    void this.runDayOnePipeline(project.id).catch((err) => {
      this.logger.error(`Day-1 pipeline crashed outside its own guard for ${project.id}: ${(err as Error).message}`);
    });

    return this.toProjectSummary(project);
  }

  private async runDayOnePipeline(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return;
    const targetUrl = /^https?:\/\//i.test(project.domain) ? project.domain : `https://${project.domain}`;

    const setStep = (step: string) => this.prisma.project.update({ where: { id: projectId }, data: { onboardingStep: step } });
    const warn = (stage: string, err: unknown) =>
      this.logger.warn(`Day-1 pipeline: ${stage} failed for ${projectId} — continuing: ${(err as Error).message}`);

    // 1. Technical audit — queued, polled.
    await setStep('technical-audit');
    try {
      const { jobId } = await this.pipelineQueue.enqueue('technical-audit', { targetUrl, projectId, triggeredBy: 'onboarding' });
      await this.pollJob(jobId);
    } catch (err) {
      warn('technical-audit', err);
    }

    // 2. Digital presence discovery — queued, polled.
    await setStep('digital-presence');
    try {
      const run = await this.presence.discover(projectId, false);
      await this.pollDiscoveryRun(run.id);
    } catch (err) {
      warn('digital-presence', err);
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

  private async pollJob(jobId: string): Promise<void> {
    const deadline = Date.now() + STAGE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await this.pipelineQueue.getStatus(jobId);
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'not_found') return;
      await new Promise((r) => setTimeout(r, STAGE_POLL_INTERVAL_MS));
    }
  }

  private async pollDiscoveryRun(runId: string): Promise<void> {
    const deadline = Date.now() + STAGE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const run = await this.prisma.presenceDiscovery.findUnique({ where: { id: runId }, select: { status: true } });
      if (!run || run.status === 'completed' || run.status === 'failed') return;
      await new Promise((r) => setTimeout(r, STAGE_POLL_INTERVAL_MS));
    }
  }

  // ─── Client login (client-portal credentials) ─────────────────────

  /**
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

  /** Posted by an authenticated OPERATOR — authorType is always "operator" here, never trusted from the caller. */
  async postMessage(clientId: string, operatorUserId: string, dto: { projectId?: string; body: string }): Promise<ClientMessageDto> {
    await this.requireClient(clientId);
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

    return {
      ...this.toClientDto(row),
      projectCount: projects.length,
      latestScore,
      latestBand,
      openGapCount,
      hasProjectOnboarding: projects.some((p) => p.onboardingStatus === 'running'),
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
      latestScore: latestReport?.scoreTotal ?? null,
      latestBand: latestReport?.scoreBand ?? null,
      latestReportSlug: latestReport?.slug ?? null,
      openGapCount,
      createdAt: project.createdAt.toISOString(),
    };
  }
}
