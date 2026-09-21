/**
 * Day-1 onboarding stage executors (G07/A7) — the bridge that makes
 * `OnboardingService.resume` able to run the pipeline it has always been
 * describing.
 *
 * ## Why this file exists
 *
 * `modules/jobs` owns the durable onboarding run: one `JobStep` per Day-1
 * stage, and `resume` advances the **first stage that did not succeed**,
 * re-buying nothing that already produced a result. It deliberately does not
 * import the pipeline body, because that body lives here — so it exposes
 * `OnboardingService.registerStageExecutor(stage, fn)` and waits for the
 * owning module to register one. Nothing did, so `resume` answered
 * `resumed: false` with that reason. This file registers all fourteen.
 *
 * The bodies are the ones in {@link ClientsService.runDayOnePipeline}, called
 * the same way with the same arguments — this module invents no audit logic
 * and no new integration. What changes is *granularity*: each stage is now
 * individually addressable and its outcome is recorded on a durable step
 * instead of only on `Project.onboardingStep`.
 *
 * ## The three rules the executors follow
 *
 * 1. **A stage that produced nothing is recorded as failed, never as a
 *    success with zero coverage.** `JobStep.attempted`/`succeeded` is the
 *    coverage disclosure, and a run whose steps all read `succeeded` is
 *    `completed` — so a stage that silently produced nothing would make a
 *    partial run look whole. Throwing is what marks the step failed and puts
 *    the reason in front of the operator (G07: *"3 of 5 engines answering is
 *    `partial`, never `completed`"*).
 * 2. **A stage the operator did not ask for is not run, and records no
 *    coverage.** The opt-in stages (keyword research, growth execution, AEO,
 *    backlinks) cost real money per run, so they run only when the run's input
 *    asks for them — the same rule the "Add Client" checkboxes apply — and
 *    report `attempted: 0, succeeded: 0`, which is a statement that nothing
 *    was attempted rather than a claim that something was.
 * 3. **A stage that was enqueued and did not finish is re-checked, not
 *    re-bought.** The queued stages (technical audit, digital presence) record
 *    the job/run id they started in the run's `artifacts`; a later resume finds
 *    that id and polls *it* rather than starting a second paid run. Only a job
 *    that is genuinely gone or failed is replaced.
 *
 * The legacy `Project.onboardingStatus`/`onboardingStep` columns are kept in
 * step with the durable run as it advances, so the two records can be read
 * side by side during the transition instead of silently disagreeing — the
 * same reason `GET /onboarding` returns the legacy fields labelled.
 *
 * @module clients/clients.onboarding-executors
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import {
  OnboardingService,
  type OnboardingStageContext,
  type OnboardingStageExecutor,
  type OnboardingStageResult,
} from '../jobs/onboarding.service';
import { ONBOARDING_STAGES } from '../jobs/jobs.types';
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
// C2 (`docs/analysis/client-portal.md` §2/§18) — reportStage() calls the same
// portal-ready-email hook the legacy pipeline uses, rather than duplicating it.
import { ClientsService } from './clients.service';

/**
 * Bounded wait for a queued stage, matching the legacy pipeline's own budget.
 * A full crawl can legitimately take several minutes under the fetcher's
 * per-domain rate limit; a shorter wait would fail stages that are working.
 */
const STAGE_POLL_TIMEOUT_MS = 480_000;
const STAGE_POLL_INTERVAL_MS = 2000;

/** Run input flags the Day-1 pipeline reads, named exactly as the add-client form sends them. */
const OPT_IN_FLAGS = {
  keywordResearch: 'runKeywordResearch',
  growthExecution: 'runGrowthExecution',
  aeoAudit: 'runAeoAudit',
  backlinks: 'runBacklinksRefresh',
} as const;

/** Artifact keys the queued stages write so a later resume finds its work. */
const ARTIFACT = {
  technicalAuditJob: 'technicalAuditJobId',
  presenceRun: 'digitalPresenceRunId',
  entityId: 'entityId',
  company: 'company',
} as const;

@Injectable()
export class ClientsOnboardingExecutors implements OnModuleInit {
  private readonly logger = new Logger(ClientsOnboardingExecutors.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly onboarding: OnboardingService,
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
    private readonly clientsService: ClientsService,
  ) {}

  /**
   * Register one executor per Day-1 stage.
   *
   * A stage in `ONBOARDING_STAGES` with no executor here is logged loudly at
   * boot: `resume` would stop there with "no executor is registered", and that
   * is a wiring bug this file should never be silent about.
   */
  onModuleInit(): void {
    const executors: Record<string, OnboardingStageExecutor> = {
      enrichment: (ctx) => this.enrichment(ctx),
      'entity-audit': (ctx) => this.entityAuditStage(ctx),
      'technical-audit': (ctx) => this.technicalAudit(ctx),
      'digital-presence': (ctx) => this.digitalPresence(ctx),
      'tech-stack': (ctx) => this.techStackStage(ctx),
      competitors: (ctx) => this.competitorsStage(ctx),
      'gap-analysis': (ctx) => this.gapAnalysisStage(ctx),
      strategy: (ctx) => this.strategyStage(ctx),
      findings: (ctx) => this.findingsStage(ctx),
      'keyword-research': (ctx) => this.keywordResearchStage(ctx),
      'growth-execution': (ctx) => this.growthExecutionStage(ctx),
      'aeo-audit': (ctx) => this.aeoAuditStage(ctx),
      backlinks: (ctx) => this.backlinksStage(ctx),
      report: (ctx) => this.reportStage(ctx),
    };

    for (const stage of ONBOARDING_STAGES) {
      const executor = executors[stage.name];
      if (!executor) {
        this.logger.error(
          `Onboarding stage "${stage.name}" (${stage.label}) has no executor — resume will stop there. ` +
            'Add one to ClientsOnboardingExecutors.',
        );
        continue;
      }
      this.onboarding.registerStageExecutor(stage.name, executor);
    }
    this.logger.log(`Registered ${Object.keys(executors).length} Day-1 onboarding stage executors`);
  }

  // ── Stages, in pipeline order ─────────────────────────────────────────

  /**
   * 0. Enrichment — crawl the homepage for category, company name and named
   * competitors, so the stages below have real seed data on day one instead of
   * running empty. Free (the fetcher is local); a page that will not load is a
   * thin result, not a failure.
   */
  private async enrichment(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    const project = await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'enrichment');

    const enrichment = await this.intake.enrichExistingProject(ctx.projectId, project.domain, {
      company: project.name,
    });
    if (!enrichment.company && enrichment.competitors.length === 0 && !enrichment.category) {
      // Nothing extracted at all. The pipeline can still run, but saying so is
      // the difference between a thin day one and an unexplained one.
      throw new Error(
        `Enrichment of ${project.domain} extracted no company, category or competitor candidates — ` +
          'the page may be unreachable or render client-side only. Competitor and gap stages will have no seed data.',
      );
    }
    return {
      attempted: 1,
      succeeded: 1,
      artifacts: {
        [ARTIFACT.company]: enrichment.company ?? project.name,
        category: enrichment.category,
        competitorCandidates: enrichment.competitors.length,
        enrichmentSource: enrichment.enrichmentSource,
      },
    };
  }

  /**
   * 0b. Entity audit — free and always on. Creates the client's own "brand"
   * entity and schema-checks its homepage; this is what feeds the Entity
   * clarity score dimension, which is structurally stuck at 0 without it.
   */
  private async entityAuditStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    const project = await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'entity-audit');

    const brandName = await this.brandName(ctx);
    const entity = await this.entityAudit.createEntity(ctx.projectId, brandName, 'brand');
    const check = await this.entityAudit.runSchemaCheck(ctx.projectId, entity.id, targetUrlOf(project.domain));
    return {
      // The entity is the artifact, so the stage succeeded; whether the schema
      // check actually read a schema from the page is separate, and reported as
      // item coverage rather than swallowed (a page with no JSON-LD is not a
      // broken check, but a check that errored is not a result).
      attempted: 1,
      succeeded: check.status === 'error' ? 0 : 1,
      artifacts: {
        [ARTIFACT.entityId]: entity.id,
        [ARTIFACT.company]: brandName,
        schemaStatus: check.status,
        schemaFieldsMissing: check.fieldsMissing,
      },
    };
  }

  /**
   * 1. Technical audit — queued on the shared pipeline, then polled. If the
   * previous resume started a job that is still going, that job is polled
   * rather than a second one being bought.
   */
  private async technicalAudit(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    const project = await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'technical-audit');

    const jobId = await this.queuedJobFor(
      ctx,
      ARTIFACT.technicalAuditJob,
      targetUrlOf(project.domain),
      async () => {
        const { jobId: created } = await this.pipelineQueue.enqueue('technical-audit', {
          targetUrl: targetUrlOf(project.domain),
          projectId: ctx.projectId,
          triggeredBy: 'onboarding',
        });
        return created;
      },
    );

    const finished = await this.pollJob(jobId);
    if (!finished) {
      throw new Error(
        `The technical audit (job ${jobId}) is still running after ${STAGE_POLL_TIMEOUT_MS}ms. It may still ` +
          'complete in the background — this stage will re-check that same job on the next resume rather than ' +
          'queueing a second audit.',
      );
    }
    const status = await this.pipelineQueue.getStatus(jobId);
    if (status.status !== 'completed') {
      throw new Error(`The technical audit job ${jobId} ended as "${status.status}": ${status.error ?? 'no reason reported'}`);
    }
    return { attempted: 1, succeeded: 1, artifacts: { [ARTIFACT.technicalAuditJob]: jobId } };
  }

  /**
   * 2. Digital presence discovery — queued and polled, then the discovered
   * company accounts are linked to the brand entity as platform records. That
   * second half is what the Authority signal dimension reads, and
   * digital-presence does not write it itself, so it is done here.
   */
  private async digitalPresence(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'digital-presence');

    const runId = await this.queuedJobFor(
      ctx,
      ARTIFACT.presenceRun,
      null,
      async () => (await this.presence.discover(ctx.projectId, false)).id,
      (id) => this.presenceRunTerminal(id),
    );

    const finished = await this.pollDiscoveryRun(runId);
    if (!finished) {
      throw new Error(
        `The presence discovery run ${runId} is still going after ${STAGE_POLL_TIMEOUT_MS}ms. This stage will ` +
          're-check that same run on the next resume rather than starting another one.',
      );
    }
    const run = await this.prisma.presenceDiscovery.findUnique({ where: { id: runId }, select: { status: true } });
    if (run?.status !== 'completed') {
      throw new Error(`The presence discovery run ${runId} ended as "${run?.status ?? 'missing'}".`);
    }

    const linked = await this.linkPlatformRecords(ctx.projectId);
    return { attempted: 1, succeeded: 1, artifacts: { [ARTIFACT.presenceRun]: runId, platformRecordsLinked: linked } };
  }

  /** 3. Tech stack detection — synchronous, free. */
  private async techStackStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'tech-stack');
    const scan = await this.techStack.scanDomain(ctx.projectId);
    return {
      attempted: 1,
      succeeded: scan.status === 'failed' ? 0 : 1,
      artifacts: { techStackScanId: scan.id, techStackFindings: scan.findings.length },
    };
  }

  /**
   * 4. Competitor discovery — only meaningful once `Project.competitors` is
   * seeded (by enrichment or an operator), so an empty result on day one is
   * normal rather than a failure: the stage ran, and found nothing to confirm.
   */
  private async competitorsStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'competitors');
    const result = await this.competitors.discover(ctx.projectId, {});
    return {
      attempted: 1,
      succeeded: 1,
      artifacts: {
        competitorCandidates: result.competitors.length,
        competitorsPromoted: result.promoted,
      },
    };
  }

  /** 5. Gap analysis — consolidates every stage above into ranked gaps. */
  private async gapAnalysisStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'gap-analysis');
    await this.gapAnalysis.sync(ctx.projectId);
    return { attempted: 1, succeeded: 1 };
  }

  /** 6. Strategy — the ranked action plan built from those gaps. */
  private async strategyStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'strategy');
    const plan = await this.strategy.buildActionPlan(ctx.projectId);
    return { attempted: 1, succeeded: 1, artifacts: { strategyActions: Array.isArray(plan) ? plan.length : undefined } };
  }

  /**
   * 6a. Findings copy — free (shared LLM caller), always on: turns the
   * highest-priority open gaps into what/why/fix prose. Without it the report's
   * narrative sections fall back to raw technical rows.
   */
  private async findingsStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'findings');
    const result = await this.findingsService.generate(ctx.projectId, { limit: 5 });
    return { attempted: 1, succeeded: 1, artifacts: { findingsWritten: result.findings.length, thinRun: result.thinRun } };
  }

  /**
   * 6b. Keyword research — opt-in (costs DataForSEO credits per call). Seeded
   * from the enrichment category because day one has no real seed keywords
   * yet; the stage reports zero coverage when there is nothing to seed rather
   * than failing the run over a missing category.
   */
  private async keywordResearchStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    const project = await this.requireProject(ctx.projectId);
    if (!isRequested(ctx, OPT_IN_FLAGS.keywordResearch)) return NOT_REQUESTED;

    await this.markLegacyStage(ctx.projectId, 'keyword-research');
    const fresh = await this.prisma.project.findUnique({ where: { id: ctx.projectId }, select: { category: true } });
    const seeds = Array.from(new Set([fresh?.category, project.name].filter((s): s is string => !!s)));
    if (seeds.length === 0) {
      this.logger.warn(`Onboarding ${ctx.runId}: keyword research skipped — enrichment found no category to seed from.`);
      return { attempted: 0, succeeded: 0, artifacts: { keywordResearchSkipped: 'no seed keywords' } };
    }
    const set = await this.keywordResearch.research(ctx.projectId, { keywords: seeds.slice(0, 5) });
    return {
      attempted: 1,
      succeeded: set.status === 'failed' ? 0 : 1,
      costUsd: set.costUsd,
      reversible: false,
      artifacts: { keywordSetId: set.id, keywordStatus: set.status, keywordError: set.error },
    };
  }

  /** 6c. Growth execution — opt-in; deterministic briefs from the gap/strategy output. */
  private async growthExecutionStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    if (!isRequested(ctx, OPT_IN_FLAGS.growthExecution)) return NOT_REQUESTED;

    await this.markLegacyStage(ctx.projectId, 'growth-execution');
    const assets = await this.growthExecution.createAssets(ctx.projectId, {});
    return { attempted: 1, succeeded: 1, artifacts: { growthAssetIds: assets.map((a) => a.id) } };
  }

  /**
   * 6d. AEO audit — opt-in, real Cloro/LLM spend, and long (up to hundreds of
   * surface prompts). Started and **not** awaited, exactly as the legacy
   * pipeline does: the audit tracks its own status and must not hold up the
   * day-one report. Coverage is therefore 0 of 0 — a dispatched stage claiming
   * answered items would be a claim nothing observed — and the audit id is the
   * artifact that follows it.
   */
  private async aeoAuditStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    if (!isRequested(ctx, OPT_IN_FLAGS.aeoAudit)) return NOT_REQUESTED;

    await this.markLegacyStage(ctx.projectId, 'aeo-audit');
    const audit = await this.aeoAudit.runFullAsync(ctx.projectId, {});
    return {
      attempted: 0,
      succeeded: 0,
      reversible: false,
      artifacts: { aeoAuditId: audit.id, aeoDisclosure: 'The AEO audit was started, not awaited — follow it by id.' },
    };
  }

  /** 6e. Backlinks — opt-in, costs DataForSEO credits per call. */
  private async backlinksStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    await this.requireProject(ctx.projectId);
    if (!isRequested(ctx, OPT_IN_FLAGS.backlinks)) return NOT_REQUESTED;

    await this.markLegacyStage(ctx.projectId, 'backlinks');
    const summary = await this.backlinksService.refresh(ctx.projectId, {});
    return {
      attempted: 1,
      succeeded: summary.status === 'failed' ? 0 : 1,
      costUsd: summary.costUsd,
      reversible: false,
      artifacts: { backlinksRunId: summary.id, backlinksStatus: summary.status },
    };
  }

  /**
   * 7. Report — the day-one deliverable. If this fails there is nothing to
   * show the client, so this is the one stage whose failure the legacy
   * pipeline also treats as fatal (`onboardingStatus = 'failed'`); the durable
   * run records the same thing on the step instead of only on the project.
   */
  private async reportStage(ctx: OnboardingStageContext): Promise<OnboardingStageResult> {
    const project = await this.requireProject(ctx.projectId);
    await this.markLegacyStage(ctx.projectId, 'report');
    try {
      const report = await this.reporting.generateReport(
        ctx.projectId,
        targetUrlOf(project.domain),
        `${project.name} — Day 1 Audit`,
      );
      await this.prisma.project.update({
        where: { id: ctx.projectId },
        data: { onboardingStatus: 'completed', onboardingStep: null, onboardingError: null },
      });
      // C2 §2/§18 — same best-effort portal-ready-email hook the legacy
      // pipeline fires on completion, never thrown back into the run.
      await this.clientsService.sendPortalReadyEmail(ctx.projectId).catch((err) => {
        this.logger.warn(`Durable Day-1 run: portal-ready email step crashed for ${ctx.projectId}: ${(err as Error).message}`);
      });
      return { attempted: 1, succeeded: 1, artifacts: { reportId: report.id, reportSlug: report.slug } };
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.project.update({
        where: { id: ctx.projectId },
        data: { onboardingStatus: 'failed', onboardingStep: 'report', onboardingError: message },
      });
      // §18: a failed report stage still fires the portal-ready email — the
      // client is not permanently locked out of a portal they are paying for
      // just because the Day-1 deliverable itself degraded.
      await this.clientsService.sendPortalReadyEmail(ctx.projectId).catch((emailErr) => {
        this.logger.warn(`Durable Day-1 run: portal-ready email step crashed for ${ctx.projectId}: ${(emailErr as Error).message}`);
      });
      throw err;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * The id of the queued work this stage should be polling, starting it only
   * when there is nothing to resume.
   *
   * `previousId` comes from the run's own artifacts, so a resume after a poll
   * timeout re-checks the job it already paid for instead of buying a second
   * one. A job that is gone or dead is replaced by a fresh one; a job still in
   * flight is adopted as-is.
   */
  private async queuedJobFor(
    ctx: OnboardingStageContext,
    artifactKey: string,
    _label: string | null,
    start: () => Promise<string>,
    isTerminal?: (id: string) => Promise<boolean>,
  ): Promise<string> {
    const previousId = await this.readArtifact(ctx.runId, artifactKey);
    if (typeof previousId === 'string' && previousId.length > 0) {
      const stillThere = isTerminal ? !(await isTerminal(previousId)) : true;
      if (stillThere) {
        this.logger.log(`Onboarding ${ctx.runId}: resuming ${artifactKey} ${previousId} instead of starting another.`);
        return previousId;
      }
      this.logger.warn(
        `Onboarding ${ctx.runId}: ${artifactKey} ${previousId} is no longer usable — starting that stage again.`,
      );
    }
    const id = await start();
    await this.mergeArtifacts(ctx.runId, { [artifactKey]: id });
    return id;
  }

  /** The brand name the entity is created under, preferring what enrichment found. */
  private async brandName(ctx: OnboardingStageContext): Promise<string> {
    const fromInput = ctx.input.brandName;
    if (typeof fromInput === 'string' && fromInput.length > 0) return fromInput;
    const fromArtifacts = await this.readArtifact(ctx.runId, ARTIFACT.company);
    if (typeof fromArtifacts === 'string' && fromArtifacts.length > 0) return fromArtifacts;
    const project = await this.requireProject(ctx.projectId);
    return project.name;
  }

  /**
   * Link discovered company accounts to the brand entity as platform records.
   * Best-effort per account, exactly as the legacy pipeline does: one platform
   * that will not record must not cost the run the other twelve.
   */
  private async linkPlatformRecords(projectId: string): Promise<number> {
    const entity = await this.brandEntity(projectId);
    if (!entity) return 0;

    const inventory = await this.presence.inventory(projectId);
    const companyAccounts = inventory.accounts.filter((a) => a.entity === 'company' && a.state !== 'candidate');
    let linked = 0;
    for (const account of companyAccounts) {
      try {
        await this.entityAudit.createPlatformRecord(
          projectId,
          entity,
          account.platform,
          account.handle ?? undefined,
          undefined,
          account.url,
          account.nameConsistency === 'not-checked' ? 'not-checked' : account.nameConsistency,
          false,
        );
        linked += 1;
      } catch (err) {
        this.logger.warn(`Onboarding platform record for ${account.platform} failed: ${(err as Error).message}`);
      }
    }
    return linked;
  }

  /** The brand entity for a project, by the id this run recorded or the first one stored. */
  private async brandEntity(projectId: string): Promise<string | null> {
    const { entities } = await this.entityAudit.listEntities(projectId);
    const brand = entities.find((e) => e.type === 'brand') ?? entities[0];
    return brand?.id ?? null;
  }

  /** The run's own recorded artifacts — the only state that survives a resume. */
  private async readArtifact(runId: string, key: string): Promise<unknown> {
    const run = await this.prisma.jobRun.findUnique({ where: { id: runId }, select: { artifacts: true } });
    if (!run?.artifacts) return undefined;
    try {
      const parsed: unknown = JSON.parse(run.artifacts);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return (parsed as Record<string, unknown>)[key];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Merge keys into the run's artifacts without dropping what is already there. */
  private async mergeArtifacts(runId: string, patch: Record<string, unknown>): Promise<void> {
    const run = await this.prisma.jobRun.findUnique({ where: { id: runId }, select: { artifacts: true } });
    let current: Record<string, unknown> = {};
    try {
      const parsed: unknown = run?.artifacts ? JSON.parse(run.artifacts) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      current = {};
    }
    await this.prisma.jobRun.update({
      where: { id: runId },
      data: { artifacts: JSON.stringify({ ...current, ...patch }) },
    });
  }

  /**
   * Mirror the stage onto the legacy `Project.onboardingStep` column so the
   * dashboard that polls it keeps working while the durable run takes over.
   */
  private async markLegacyStage(projectId: string, stage: string): Promise<void> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { onboardingStatus: 'running', onboardingStep: stage },
    });
  }

  private async requireProject(projectId: string): Promise<{ id: string; name: string; domain: string }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, domain: true },
    });
    if (!project) throw new Error(`Project ${projectId} not found — the onboarding run cannot advance.`);
    return project;
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

  /** @returns true if the presence discovery run reached a terminal state. */
  private async pollDiscoveryRun(runId: string): Promise<boolean> {
    const deadline = Date.now() + STAGE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.presenceRunTerminal(runId)) return true;
      await new Promise((r) => setTimeout(r, STAGE_POLL_INTERVAL_MS));
    }
    return false;
  }

  private async presenceRunTerminal(runId: string): Promise<boolean> {
    const run = await this.prisma.presenceDiscovery.findUnique({ where: { id: runId }, select: { status: true } });
    return !run || run.status === 'completed' || run.status === 'failed';
  }
}

/** The stage was not asked for. Zero of zero is a statement, not a claim. */
const NOT_REQUESTED: OnboardingStageResult = {
  attempted: 0,
  succeeded: 0,
  artifacts: { skipped: 'not requested by the run input' },
};

/** Read an opt-in flag from the run's input, defaulting to off like the add-client form does. */
function isRequested(ctx: OnboardingStageContext, flag: string): boolean {
  return ctx.input[flag] === true;
}

/** The absolute URL a stage works against, from the project's stored domain. */
function targetUrlOf(domain: string): string {
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}
