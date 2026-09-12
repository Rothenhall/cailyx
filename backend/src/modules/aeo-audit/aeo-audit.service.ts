/**
 * AEO Audit Service — the orchestrator and the verdict.
 *
 * Runs the whole pipeline for one project:
 *   context → matrix → measurement (n>=5 on ChatGPT) → stance → verdict.
 *
 * Each stage is also callable on its own, so an operator can rebuild just the
 * matrix, or re-judge a run, without paying for the stages before it. The
 * `AeoAudit` row records the last completed stage, so a failed audit says where
 * it stopped instead of vanishing.
 *
 * The verdict keeps two blocks apart, deliberately (D4):
 * - `counted` — mention rate, citation rate, share of voice. Deterministic
 *   extraction over n>=5 repeats. These are the numbers that may be quoted.
 * - `judged` — competitive stance. An LLM reading the same answers. Reported
 *   with evidence quotes, never as a rate.
 *
 * @module aeo-audit.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { MeasurementService, MIN_RUN_COUNT } from '../measurement/measurement.service';
import { CloroAdapterError, CloroClient, CLORO_BASE_CREDITS, type CloroSurface } from '../measurement/adapters/cloro.adapter';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import { AeoContextService } from './aeo-context.service';
import { AeoMatrixService } from './aeo-matrix.service';
import { AeoStanceService, type StancePassResult } from './aeo-stance.service';
import {
  AEO_SURFACES,
  DIMENSION_LABELS,
  PROMPT_DIMENSIONS,
  STANCES,
  SURFACE_LABELS,
  TIER_SIZES,
} from './aeo-audit.types';
import type {
  AeoBudgetEstimate,
  AeoSurface,
  AeoVerdict,
  CompetitorStanding,
  DimensionResult,
  MatrixTier,
  MarketResult,
  MarketSurfaceResult,
  MarketCompetitorStandings,
  PromptDimension,
  PromptMeta,
  SiteContextData,
  SliceMetrics,
  Stance,
  StanceVerdict,
  SurfaceComparison,
  SurfaceRunResult,
  SurfaceRunStatus,
} from './aeo-audit.types';
import type { FunnelStage } from '../query-set/query-set.types';

/**
 * A failed Cloro surface retries once on its browser equivalent (wave-6 D1).
 * `cloro-ai-overview` and `cloro-ai-mode` have no browser equivalent and fail
 * closed.
 */
const CLORO_FALLBACK: Partial<Record<string, AeoSurface>> = {
  'cloro-chatgpt': 'chatgpt-browser',
  'cloro-perplexity': 'perplexity-browser',
  'cloro-gemini': 'gemini-browser',
};

/** Options for a full end-to-end audit. */
export interface RunAuditInput {
  /** Single-engine shorthand. Ignored when `surfaces` is given. */
  surface?: AeoSurface;
  /** Measure several engines with the same matrix and compare them. */
  surfaces?: AeoSurface[];
  tier?: MatrixTier;
  runCount?: number;
  geo?: string;
  /**
   * Explicit market override (wave-6 D8, precedence #1) — ISO-3166 alpha-2
   * codes. Given, this fans out `surface × market` immediately at `start()`.
   * Omitted, the default single market is derived from the site's own
   * context (`SiteContextData.markets[0]` → `geo` → `'US'`) once context
   * loads in `resume()`.
   */
  markets?: string[];
  /** Reuse the latest stored context instead of re-scraping. */
  reuseContext?: boolean;
  /** Skip the stance pass (counted metrics only). */
  skipStance?: boolean;
  /** Skip the LLM phrasing pass on the matrix. */
  skipRefine?: boolean;
}

@Injectable()
export class AeoAuditService {
  private readonly logger = new Logger(AeoAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly context: AeoContextService,
    private readonly matrix: AeoMatrixService,
    private readonly stance: AeoStanceService,
    private readonly measurement: MeasurementService,
    private readonly pipelineQueue: PipelineQueueService,
    private readonly cloro: CloroClient,
  ) {
    // Resuming is safe to retry: it skips any stage/surface already completed.
    this.pipelineQueue.registerHandler('aeo-audit-resume', (data: {
      auditId: string; input: RunAuditInput;
    }) => this.resume(data.auditId, data.input));
  }

  // ─── Orchestration ─────────────────────────────────────────────────────

  /**
   * Run the full pipeline and return the finished audit with its verdict.
   *
   * Long-running by nature: a 100-prompt matrix at n=5 is 500 prompts on the
   * surface. Callers that cannot hold a request open should use {@link start}
   * plus polling on {@link get}.
   *
   * @throws NotFoundException when the project does not exist.
   * @throws BadRequestException when runCount < 5 (n>=5, no exceptions).
   */
  async runFull(projectId: string, input: RunAuditInput = {}) {
    const audit = await this.start(projectId, input);
    return this.resume(audit.id, input);
  }

  /**
   * Create the audit row, then queue the resume on the background pipeline
   * and return immediately — the async counterpart to {@link runFull}. Poll
   * {@link get} (or list audits) for `status`/`stage` until `completed`.
   *
   * @throws NotFoundException when the project does not exist.
   * @throws BadRequestException when runCount < 5 (n>=5, no exceptions).
   */
  async runFullAsync(projectId: string, input: RunAuditInput = {}) {
    const audit = await this.start(projectId, input);
    await this.pipelineQueue.enqueue(
      'aeo-audit-resume',
      { auditId: audit.id, input },
      { attempts: 3, backoff: { type: 'exponential', delay: 30000 } },
    );
    return audit;
  }

  /**
   * Create the audit row. Cheap — no scraping, no spend.
   * @throws NotFoundException when the project does not exist.
   */
  async start(projectId: string, input: RunAuditInput = {}) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const runCount = input.runCount ?? MIN_RUN_COUNT;
    if (runCount < MIN_RUN_COUNT) {
      throw new BadRequestException(`n>=5, no exceptions: runCount must be >= ${MIN_RUN_COUNT}`);
    }

    const surfaces = this.resolveSurfaces(input);

    // Markets (wave-6 D8): an explicit override needs no context, so it fans
    // out surface × market immediately. Without one, the default single
    // market can only be derived once context exists — resume() stamps it
    // onto these rows (still `market: null` here) once it loads.
    const markets = input.markets?.length ? this.normalizeMarkets(input.markets) : [];
    const surfaceRunRows = markets.length > 0
      ? surfaces.flatMap((surface) => markets.map((market) => ({ surface, market, status: 'pending' })))
      : surfaces.map((surface) => ({ surface, market: null, status: 'pending' }));

    return this.prisma.aeoAudit.create({
      data: {
        projectId,
        surface: surfaces[0],
        surfaces: JSON.stringify(surfaces),
        markets: JSON.stringify(markets),
        tier: input.tier ?? this.defaultTier(),
        runCount,
        status: 'pending',
        surfaceRuns: { create: surfaceRunRows },
      },
      include: { surfaceRuns: true },
    });
  }

  /** Uppercase, dedupe, drop anything not shaped like an ISO-3166 alpha-2 code. */
  private normalizeMarkets(markets: string[]): string[] {
    const out: string[] = [];
    for (const m of markets) {
      const code = this.normalizeMarketCode(m);
      if (code && !out.includes(code)) out.push(code);
    }
    return out;
  }

  /** A single value, uppercased, or `null` when it is not a real ISO-3166 alpha-2 code. */
  private normalizeMarketCode(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
  }

  /**
   * The single default market for a surface run that has none yet, per
   * wave-6 D8's precedence: the operator's own `geo` (the pre-existing
   * single-value override, kept working exactly as before this fanned out
   * to markets), then the site's own top-ranked stated service area, then
   * its ccTLD-derived geo, then the pre-existing hardcoded fallback — never
   * a bare guess with no signal at all.
   *
   * `geo` is validated the same way `markets[]` already is — an audit found
   * this was the one override that skipped the check, so a caller passing
   * `geo: "ireland"` or `geo: "en-IE"` would have persisted verbatim into
   * `AeoSurfaceRun.market` and every downstream market slice, silently
   * breaking the "ISO-3166 alpha-2" contract every other market value keeps.
   * An invalid `geo` is dropped, not thrown on — it just falls through to the
   * next signal in the precedence, same as an absent one always has.
   */
  private resolveDefaultMarket(input: RunAuditInput, context: SiteContextData): string {
    return (
      this.normalizeMarketCode(input.geo) ??
      this.normalizeMarketCode(context.markets[0]) ??
      this.normalizeMarketCode(context.geo) ??
      'US'
    );
  }

  /**
   * Which engines this audit measures.
   *
   * `surfaces` wins; `surface` is the single-surface shorthand. Duplicates are
   * dropped and order is preserved, because the first is recorded as the audit's
   * primary for callers that only understand one.
   */
  private resolveSurfaces(input: RunAuditInput): AeoSurface[] {
    const requested = input.surfaces?.length
      ? input.surfaces
      : input.surface
        ? [input.surface]
        : this.defaultSurfaces();
    const out: AeoSurface[] = [];
    for (const surface of requested) {
      if (!out.includes(surface)) out.push(surface);
    }
    return out;
  }

  /** Default engine set, overridable with `AEO_SURFACES`. */
  private defaultSurfaces(): AeoSurface[] {
    const raw = this.config.get<string>('AEO_SURFACES', 'chatgpt-browser');
    const parsed = raw
      .split(',')
      .map((v) => v.trim())
      .filter((v): v is AeoSurface => (AEO_SURFACES as readonly string[]).includes(v));
    return parsed.length > 0 ? parsed : ['chatgpt-browser'];
  }

  /**
   * Drive an audit through every stage it has not completed yet.
   *
   * Resumable: an audit that failed during measurement picks up from its stored
   * context and matrix instead of re-scraping and re-generating.
   *
   * @throws NotFoundException when the audit does not exist.
   * @throws ConflictException when the audit is already completed.
   */
  async resume(auditId: string, input: RunAuditInput = {}) {
    const audit = await this.prisma.aeoAudit.findUnique({ where: { id: auditId } });
    if (!audit) throw new NotFoundException('Audit not found: ' + auditId);
    if (audit.status === 'completed') {
      throw new ConflictException('Audit ' + auditId + ' is already completed — start a new one to re-measure');
    }

    const startedAt = audit.startedAt ?? new Date();
    await this.prisma.aeoAudit.update({
      where: { id: auditId },
      data: { status: 'context', startedAt, error: null },
    });

    try {
      // ── 1. Site context ────────────────────────────────────────────────
      let contextId = audit.contextId;
      if (!contextId) {
        const existing = input.reuseContext ? await this.context.latest(audit.projectId) : null;
        const built = existing ?? (await this.context.build(audit.projectId, { refine: !input.skipRefine }));
        contextId = built.id;
        await this.prisma.aeoAudit.update({
          where: { id: auditId },
          data: { contextId, stage: 'context', costUsd: { increment: existing ? 0 : built.costUsd } },
        });
      }
      const context = await this.context.get(contextId);

      // Markets (wave-6 D8): rows created without an explicit override carry
      // `market: null` from start() — stamp the context-derived default onto
      // them now that context exists. An explicit override already resolved
      // its markets at start() and is left untouched here.
      const unresolvedMarket = await this.prisma.aeoSurfaceRun.findFirst({
        where: { auditId, market: null },
      });
      if (unresolvedMarket) {
        const defaultMarket = this.resolveDefaultMarket(input, context);
        await this.prisma.aeoSurfaceRun.updateMany({
          where: { auditId, market: null },
          data: { market: defaultMarket },
        });
        await this.prisma.aeoAudit.update({
          where: { id: auditId },
          data: { markets: JSON.stringify([defaultMarket]) },
        });
      }

      // ── 2. Prompt matrix ───────────────────────────────────────────────
      let querySetId = audit.querySetId;
      if (!querySetId) {
        await this.prisma.aeoAudit.update({ where: { id: auditId }, data: { status: 'matrix' } });
        const built = await this.matrix.generate(audit.projectId, context, {
          tier: audit.tier as MatrixTier,
          refine: !input.skipRefine,
          activate: true,
        });
        querySetId = built.querySetId;
        await this.prisma.aeoAudit.update({
          where: { id: auditId },
          data: {
            querySetId,
            promptCount: built.promptCount,
            stage: 'matrix',
            costUsd: { increment: built.costUsd },
          },
        });
      }

      // ── 3. Measurement, one run per engine (n>=5 each) ─────────────────
      //
      // Engines are measured independently and a failure is contained: if
      // Gemini is blocked but ChatGPT and Perplexity answer, the audit still
      // completes and names the engine that produced nothing. Voiding two good
      // engines because a third was blocked would throw away the finding.
      await this.prisma.aeoAudit.update({ where: { id: auditId }, data: { status: 'running' } });
      const surfaceRuns = await this.prisma.aeoSurfaceRun.findMany({
        where: { auditId },
        orderBy: { createdAt: 'asc' },
      });

      for (const surfaceRun of surfaceRuns) {
        if (surfaceRun.status === 'completed') continue;

        // Pre-flight budget guard for Cloro surfaces: refuse to start a run
        // that cannot finish inside the remaining monthly credit allowance
        // rather than burning most of it and stopping half way (wave-6 D1/Step 1).
        if (surfaceRun.surface.startsWith('cloro-')) {
          const fits = await this.cloroFitsBudget(surfaceRun.surface, audit.promptCount ?? 0, audit.runCount);
          if (!fits.ok) {
            await this.prisma.aeoSurfaceRun.update({
              where: { id: surfaceRun.id },
              data: {
                status: 'failed',
                failureKind: fits.failureKind,
                error: fits.reason,
                finishedAt: new Date(),
              },
            });
            this.logger.warn(`Audit ${auditId}: ${surfaceRun.surface} skipped — ${fits.reason}`);
            continue;
          }
        }

        await this.prisma.aeoSurfaceRun.update({
          where: { id: surfaceRun.id },
          data: { status: 'running', startedAt: surfaceRun.startedAt ?? new Date(), error: null, failureKind: null },
        });

        // Which surface actually produced the run — starts as the requested
        // one, and only changes if a Cloro failure falls back to its browser
        // equivalent. Recorded as `attemptedVia` so a fallback is never
        // reported as a Cloro measurement.
        const originalSurface = surfaceRun.surface as AeoSurface;
        let attemptedVia: AeoSurface = originalSurface;

        const attempt = async (surface: AeoSurface) => {
          // Reuse the stored runId only when retrying the originally-requested
          // surface (a resume after a crash mid-run) — a fallback attempt is a
          // different surface and must always get its own fresh run, never the
          // Cloro run's id.
          let runId = surface === originalSurface ? surfaceRun.runId : null;
          if (!runId) {
            // `surfaceRun.market` is resolved by now — either the operator's
            // `markets[]` override (fanned out at start()) or the
            // context-derived default `resolveDefaultMarket` just stamped on
            // above, which already folds in `input.geo` at top precedence.
            const run = await this.measurement.createRun(audit.projectId, {
              querySetId,
              surface,
              geo: surfaceRun.market ?? input.geo,
              runCount: audit.runCount,
            });
            runId = run.id;
            await this.prisma.aeoSurfaceRun.update({ where: { id: surfaceRun.id }, data: { runId } });
          }

          const executed = await this.measurement.executeRun(runId);
          if (!executed) throw new Error('Measurement run vanished during execution: ' + runId);

          // `executeRun` absorbs per-observation errors so one bad answer cannot
          // kill a long run. Zero completions means every call failed — a
          // disabled, signed-out or blocked engine — and metrics built on
          // nothing would be a lie.
          if (executed.completedRequests === 0) {
            throw new Error(
              'no observations (' + executed.failedRequests + ' failed). ' +
                (executed.error ?? this.surfaceHint(surface)),
            );
          }
          return executed;
        };

        try {
          const executed = await attempt(attemptedVia);

          await this.prisma.aeoSurfaceRun.update({
            where: { id: surfaceRun.id },
            data: {
              status: 'completed',
              observations: executed.completedRequests,
              costUsd: executed.costTotal,
              attemptedVia,
              finishedAt: new Date(),
            },
          });
          await this.prisma.aeoAudit.update({
            where: { id: auditId },
            data: {
              observations: { increment: executed.completedRequests },
              costUsd: { increment: executed.costTotal },
            },
          });
          this.logger.log(
            `Audit ${auditId}: ${surfaceRun.surface} completed with ${executed.completedRequests} observations`,
          );
        } catch (err) {
          const message = (err as Error).message;

          // Fallback chain (wave-6 D1): a failed cloro-* surface retries once on
          // its *-browser equivalent, but only when that browser surface is
          // itself enabled — never a second silent attempt with nothing to show.
          const fallback = CLORO_FALLBACK[surfaceRun.surface];
          const fallbackEnabled = !!fallback && this.config.get<string>('AEO_ALLOW_BROWSER_SURFACE') === '1';
          if (fallback && fallbackEnabled && attemptedVia === surfaceRun.surface) {
            this.logger.warn(`Audit ${auditId}: ${surfaceRun.surface} failed — ${message}. Falling back to ${fallback}.`);
            attemptedVia = fallback;
            try {
              const executed = await attempt(fallback);
              await this.prisma.aeoSurfaceRun.update({
                where: { id: surfaceRun.id },
                data: {
                  status: 'completed',
                  observations: executed.completedRequests,
                  costUsd: executed.costTotal,
                  attemptedVia,
                  finishedAt: new Date(),
                },
              });
              await this.prisma.aeoAudit.update({
                where: { id: auditId },
                data: {
                  observations: { increment: executed.completedRequests },
                  costUsd: { increment: executed.costTotal },
                },
              });
              this.logger.log(
                `Audit ${auditId}: ${surfaceRun.surface} completed via fallback ${fallback} with ${executed.completedRequests} observations`,
              );
              continue;
            } catch (fallbackErr) {
              const fallbackMessage = (fallbackErr as Error).message;
              await this.prisma.aeoSurfaceRun.update({
                where: { id: surfaceRun.id },
                data: {
                  status: 'failed',
                  failureKind: this.classifyFailure(fallbackMessage),
                  error: `Cloro failed (${message}); fallback ${fallback} also failed: ${fallbackMessage}`.slice(0, 500),
                  attemptedVia,
                  finishedAt: new Date(),
                },
              });
              this.logger.warn(`Audit ${auditId}: ${surfaceRun.surface} fallback ${fallback} also failed — ${fallbackMessage}`);
              continue;
            }
          }

          await this.prisma.aeoSurfaceRun.update({
            where: { id: surfaceRun.id },
            data: {
              status: 'failed',
              failureKind: this.classifyFailure(message),
              error: message.slice(0, 500),
              attemptedVia,
              finishedAt: new Date(),
            },
          });
          this.logger.warn(`Audit ${auditId}: ${surfaceRun.surface} failed — ${message}`);
        }
      }

      const measured = await this.prisma.aeoSurfaceRun.findMany({
        where: { auditId, status: 'completed' },
      });
      if (measured.length === 0) {
        const failures = await this.prisma.aeoSurfaceRun.findMany({ where: { auditId } });
        throw new BadRequestException(
          'Every engine failed, so there is nothing to report. ' +
            failures.map((f) => `${f.surface}: ${f.error ?? 'unknown'}`).join(' | '),
        );
      }
      await this.prisma.aeoAudit.update({ where: { id: auditId }, data: { stage: 'measurement' } });

      // ── 4. Stance (judged, optional) ───────────────────────────────────
      if (!input.skipStance && this.stance.isAvailable()) {
        await this.prisma.aeoAudit.update({ where: { id: auditId }, data: { status: 'judging' } });
        const project = await this.prisma.project.findUnique({ where: { id: audit.projectId } });
        const subject = { name: project?.name ?? context.brand, domain: context.domain };
        const rivals = context.competitors.map((c) => c.name);

        // The cap covers the whole audit, so each engine is given what is left
        // rather than a full budget of its own.
        let spent = 0;
        for (const run of measured) {
          if (!run.runId) continue;
          const remaining = this.costCap() - spent;
          if (remaining <= 0) {
            this.logger.warn(`Stance budget exhausted before ${run.surface} — left unjudged`);
            break;
          }
          const pass = await this.stance.judgeRun(auditId, run.runId, subject, rivals, remaining, run.surface);
          spent += pass.costUsd;
          await this.prisma.aeoSurfaceRun.update({
            where: { id: run.id },
            data: { stanceJudged: pass.judged, costUsd: { increment: pass.costUsd } },
          });
          await this.prisma.aeoAudit.update({
            where: { id: auditId },
            data: { stanceJudged: { increment: pass.judged }, costUsd: { increment: pass.costUsd } },
          });
        }
        await this.prisma.aeoAudit.update({ where: { id: auditId }, data: { stage: 'stance' } });
      }

      // ── 5. Verdict ─────────────────────────────────────────────────────
      const verdict = await this.buildVerdict(auditId);
      const finished = await this.prisma.aeoAudit.update({
        where: { id: auditId },
        data: {
          status: 'completed',
          stage: 'verdict',
          verdict: JSON.stringify(verdict),
          finishedAt: new Date(),
        },
      });

      this.logger.log(
        `AEO audit ${auditId} completed: ${verdict.counted.overall.observations} observations, ` +
          `mention rate ${(verdict.counted.overall.mentionRate * 100).toFixed(1)}% ` +
          `(unbranded ${(verdict.counted.unbranded.mentionRate * 100).toFixed(1)}%)`,
      );

      return { ...finished, verdict };
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.aeoAudit.update({
        where: { id: auditId },
        data: { status: 'failed', error: message.slice(0, 500), finishedAt: new Date() },
      });
      this.logger.error(`AEO audit ${auditId} failed: ${message}`);
      throw err;
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────

  /** One audit, with its verdict parsed. @throws NotFoundException when missing. */
  async get(auditId: string) {
    const audit = await this.prisma.aeoAudit.findUnique({ where: { id: auditId } });
    if (!audit) throw new NotFoundException('Audit not found: ' + auditId);
    return { ...audit, verdict: this.parseVerdict(audit.verdict) };
  }

  /** Audits for a project, newest first. */
  async list(projectId: string) {
    const rows = await this.prisma.aeoAudit.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      surface: row.surface,
      tier: row.tier,
      status: row.status,
      stage: row.stage,
      promptCount: row.promptCount,
      observations: row.observations,
      stanceJudged: row.stanceJudged,
      costUsd: row.costUsd,
      error: row.error,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }));
  }

  /**
   * Recompute the verdict for an audit from its stored observations and stances.
   * Cheap and side-effect free — safe to call after adding stance judgements.
   */
  async verdict(auditId: string): Promise<AeoVerdict> {
    return this.buildVerdict(auditId);
  }

  /**
   * Run (or finish) the stance pass for an audit, then refresh its stored verdict
   * so the judged block is immediately visible to readers of `GET /audits/:id`.
   *
   * Idempotent — observations already judged are skipped, so this can be called
   * again after a pass that stopped at the cost cap.
   *
   * @throws NotFoundException when the audit, its run, or the project is missing.
   * @throws ServiceUnavailableException when no `ANTHROPIC_API_KEY` is configured.
   */
  async judgeStance(projectId: string, auditId: string): Promise<StancePassResult> {
    const audit = await this.prisma.aeoAudit.findUnique({
      where: { id: auditId },
      include: { surfaceRuns: true },
    });
    if (!audit) throw new NotFoundException('Audit not found: ' + auditId);

    // `AeoAudit.runId` is a legacy single-surface field the multi-surface
    // pipeline (resume()) never sets — every run id lives on its own
    // `AeoSurfaceRun` row instead (one per surface, or per surface × market
    // once wave-6 D8's multi-market runs are in play). Reading `audit.runId`
    // here made this endpoint 400 on every audit ever produced by resume();
    // iterating the surface runs is what resume()'s own automatic stance
    // pass already does, so this mirrors that rather than a legacy field.
    const runnable = audit.surfaceRuns.filter((sr) => sr.status === 'completed' && sr.runId);
    if (runnable.length === 0) {
      throw new BadRequestException('Audit ' + auditId + ' has no completed measurement run to judge yet');
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    const context = audit.contextId ? await this.context.get(audit.contextId) : await this.context.latest(projectId);
    const subject = { name: project.name, domain: context?.domain ?? project.domain };
    const rivals = (context?.competitors ?? []).map((c) => c.name);

    // The cap covers the whole call, same discipline as resume()'s own pass —
    // each engine gets what budget is left, not a fresh allowance each.
    const budget = this.costCap();
    let spent = 0;
    const total: StancePassResult = { judged: 0, skipped: 0, failed: 0, costUsd: 0, judgeModel: '' };

    for (const run of runnable) {
      const remaining = budget - spent;
      if (remaining <= 0) {
        this.logger.warn(`Stance budget exhausted before ${run.surface} (audit ${auditId}) — left unjudged`);
        break;
      }
      const pass = await this.stance.judgeRun(auditId, run.runId!, subject, rivals, remaining, run.surface);
      spent += pass.costUsd;
      total.judged += pass.judged;
      total.skipped += pass.skipped;
      total.failed += pass.failed;
      total.costUsd += pass.costUsd;
      total.judgeModel = pass.judgeModel;
      await this.prisma.aeoSurfaceRun.update({
        where: { id: run.id },
        data: { stanceJudged: { increment: pass.judged }, costUsd: { increment: pass.costUsd } },
      });
    }

    const verdict = await this.buildVerdict(auditId);
    await this.prisma.aeoAudit.update({
      where: { id: auditId },
      data: {
        stanceJudged: { increment: total.judged },
        costUsd: { increment: total.costUsd },
        verdict: JSON.stringify(verdict),
      },
    });

    return total;
  }

  // ─── Verdict computation ───────────────────────────────────────────────

  /**
   * Roll observations + stances into the report object.
   *
   * Rates are computed here by counting rows — the same discipline `measurement`
   * applies — and the judged block is assembled separately so the two can never
   * be conflated by a consumer.
   */
  private async buildVerdict(auditId: string): Promise<AeoVerdict> {
    const audit = await this.prisma.aeoAudit.findUnique({
      where: { id: auditId },
      include: { surfaceRuns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!audit) throw new NotFoundException('Audit not found: ' + auditId);

    // Every (surface, market) run that produced observations. A failed run
    // still appears in the report — with its reason — it just contributes no
    // rows. One surface can have several runIds now (one per market, wave-6
    // D8), so this maps runId → {surface, market} rather than assuming one
    // run per surface.
    const runMeta = new Map<string, { surface: string; market: string | null }>();
    for (const sr of audit.surfaceRuns) {
      if (sr.runId && sr.status === 'completed') runMeta.set(sr.runId, { surface: sr.surface, market: sr.market });
    }
    // Fall back to the legacy single run for audits created before multi-surface.
    if (runMeta.size === 0 && audit.runId) runMeta.set(audit.runId, { surface: audit.surface, market: null });
    if (runMeta.size === 0) {
      throw new BadRequestException('Audit ' + auditId + ' has not measured anything yet');
    }

    const observations = await this.prisma.observation.findMany({
      where: { runId: { in: [...runMeta.keys()] } },
      orderBy: { createdAt: 'asc' },
    });
    // Distinct markets actually measured — drives whether byMarket/
    // byMarketSurface appear at all (never for a plain single-market audit).
    const marketsMeasured = [...new Set([...runMeta.values()].map((m) => m.market).filter((m): m is string => !!m))];

    // Prompt → its matrix categorisation.
    const items = audit.querySetId
      ? await this.prisma.querySetItem.findMany({
          where: { querySetId: audit.querySetId },
          select: { prompt: true, dimension: true, funnelStage: true, meta: true },
        })
      : [];
    const byPrompt = new Map(items.map((i) => [i.prompt, i]));

    const stances = await this.stance.list(auditId);
    const stanceByObs = new Map(stances.map((s) => [s.observationId, s]));

    // ── Counted ───────────────────────────────────────────────────────────
    const rows = observations.map((obs) => {
      const item = byPrompt.get(obs.prompt);
      const meta = this.parseMeta(item?.meta ?? null);
      const runInfo = runMeta.get(obs.runId);
      return {
        // Carried so a stance can be matched to the exact repeat it judged.
        // Matching on `prompt` would collapse all n>=5 repeats onto whichever
        // observation happened to be found first.
        id: obs.id,
        surface: runInfo?.surface ?? audit.surface,
        market: runInfo?.market ?? null,
        prompt: obs.prompt,
        mentioned: obs.mentioned,
        cited: obs.cited,
        competitors: this.parseArray(obs.competitors),
        dimension: this.asDimension(item?.dimension ?? null),
        funnelStage: (item?.funnelStage ?? null) as FunnelStage | null,
        branding: meta?.branding ?? null,
      };
    });

    const overall = this.metrics(rows);
    const unbranded = this.metrics(rows.filter((r) => r.branding === 'unbranded'));
    const branded = this.metrics(rows.filter((r) => r.branding === 'branded'));

    const byDimension: DimensionResult[] = PROMPT_DIMENSIONS.map((dimension) => {
      const slice = rows.filter((r) => r.dimension === dimension);
      if (slice.length === 0) return null;
      const stanceCounts = this.emptyStanceCounts();
      for (const row of slice) {
        const judged = stanceByObs.get(row.id);
        if (judged) stanceCounts[judged.stance]++;
      }
      return {
        dimension,
        label: DIMENSION_LABELS[dimension],
        ...this.metrics(slice),
        stanceCounts,
      };
    }).filter((d): d is DimensionResult => d !== null);

    const stages: FunnelStage[] = ['problem-aware', 'solution-aware', 'product-aware', 'most-aware'];
    const byFunnelStage = stages
      .map((funnelStage) => {
        const slice = rows.filter((r) => r.funnelStage === funnelStage);
        return slice.length > 0 ? { funnelStage, ...this.metrics(slice) } : null;
      })
      .filter((s): s is SliceMetrics & { funnelStage: FunnelStage } => s !== null);

    // Share of voice comes from the primary engine's run: `measurement.summary`
    // is per-run by design, and averaging SOV across engines would invent a
    // number no single engine produced. Per-engine detail lives in `bySurface`.
    const primaryRunId =
      [...runMeta.entries()].find(([, m]) => m.surface === audit.surface)?.[0] ?? [...runMeta.keys()][0];
    const summary = await this.measurement.summary(audit.projectId, primaryRunId);
    const competitors = this.competitorStandings(rows, stances, stanceByObs, observations);

    // ── Per-engine comparison ─────────────────────────────────────────────
    const stanceBySurface = new Map<string, StanceVerdict[]>();
    for (const verdict of stances) {
      const key = verdict.surface ?? audit.surface;
      const bucket = stanceBySurface.get(key);
      if (bucket) bucket.push(verdict);
      else stanceBySurface.set(key, [verdict]);
    }

    // One surface can now have several rows (one per market, wave-6 D8) — this
    // aggregates across them, so `bySurface` keeps meaning "how did ChatGPT do
    // overall" regardless of how many markets it was measured in. The per-cell
    // (surface, market) breakdown is `surfaceRunResults` below, unaggregated.
    const surfaceRunStatus = (surface: string): SurfaceRunStatus => {
      const runs = audit.surfaceRuns.filter((sr) => sr.surface === surface);
      if (runs.some((sr) => sr.status === 'completed')) return 'completed';
      if (runs.some((sr) => sr.status === 'running')) return 'running';
      if (runs.some((sr) => sr.status === 'pending')) return 'pending';
      return (runs[0]?.status as SurfaceRunStatus) ?? 'failed';
    };
    const uniqueSurfaces = [...new Set(audit.surfaceRuns.map((sr) => sr.surface))];
    const bySurface: SurfaceComparison[] = uniqueSurfaces.map((surface) => {
      const slice = rows.filter((r) => r.surface === surface);
      const unbrandedSlice = slice.filter((r) => r.branding === 'unbranded');
      const counts = this.emptyStanceCounts();
      for (const verdict of stanceBySurface.get(surface) ?? []) counts[verdict.stance]++;

      return {
        surface: surface as AeoSurface,
        label: SURFACE_LABELS[surface as AeoSurface] ?? surface,
        status: surfaceRunStatus(surface),
        ...this.metrics(slice),
        unbrandedMentionRate: this.metrics(unbrandedSlice).mentionRate,
        stanceCounts: counts,
        // Counted: answers on this engine that named a rival and not the client.
        rivalsAheadCount: slice.filter((r) => !r.mentioned && r.competitors.length > 0).length,
      };
    });

    // Per-market aggregate across every surface measured in that market —
    // only meaningful (and only shown by callers) once more than one market
    // was actually measured; a plain single-market audit's `marketsMeasured`
    // has at most one entry and this stays a one-item array.
    const byMarket: MarketResult[] = marketsMeasured
      .map((market) => {
        const slice = rows.filter((r) => r.market === market);
        if (slice.length === 0) return null;
        return { market, ...this.metrics(slice) };
      })
      .filter((m): m is MarketResult => m !== null);

    // Competitors per market (stage 6, "Competitors by Area / Market"). The
    // aggregate `competitors` list averages a rival who dominates GB and is
    // absent from the US into a middling global row describing neither -- and
    // market entry is decided per market. Re-runs the same standings function
    // over each market's own slice rather than reweighting the aggregate, so a
    // per-market row means exactly what the global row means.
    const byMarketCompetitors: MarketCompetitorStandings[] = marketsMeasured
      .map((market) => {
        const marketRows = rows.filter((r) => r.market === market);
        if (marketRows.length === 0) return null;
        const ids = new Set(marketRows.map((r) => r.id));
        return {
          market,
          competitors: this.competitorStandings(
            marketRows,
            stances.filter((v) => ids.has(v.observationId)),
            stanceByObs,
            observations.filter((o) => ids.has(o.id)),
          ),
        };
      })
      .filter((m): m is MarketCompetitorStandings => m !== null);

    // Market x engine, unaggregated. `byMarket` alone says "weaker in GB";
    // `bySurface` alone says "weaker on Gemini". Only the cross says *Gemini in
    // GB* is the hole -- and that is the one an operator can act on. Empty for a
    // single-market audit, where it would only repeat `bySurface`.
    const byMarketSurface: MarketSurfaceResult[] =
      marketsMeasured.length > 1
        ? marketsMeasured.flatMap((market) =>
            uniqueSurfaces
              .map((surface) => {
                const slice = rows.filter((r) => r.market === market && r.surface === surface);
                if (slice.length === 0) return null;
                const unbranded = slice.filter((r) => r.branding === 'unbranded');
                const run = audit.surfaceRuns.find((sr) => sr.surface === surface && sr.market === market);
                return {
                  market,
                  surface: surface as AeoSurface,
                  label: SURFACE_LABELS[surface as AeoSurface] ?? surface,
                  // This cell's own run status -- a cell whose engine failed in
                  // one market but worked in another must not inherit the
                  // aggregate, or a real per-market failure disappears.
                  status: (run?.status as SurfaceRunStatus) ?? 'skipped',
                  ...this.metrics(slice),
                  unbrandedMentionRate: this.metrics(unbranded).mentionRate,
                };
              })
              .filter((r): r is MarketSurfaceResult => r !== null),
          )
        : [];

    const surfaceRunResults: SurfaceRunResult[] = audit.surfaceRuns.map((sr) => ({
      surface: sr.surface as AeoSurface,
      label: SURFACE_LABELS[sr.surface as AeoSurface] ?? sr.surface,
      market: sr.market,
      status: sr.status as SurfaceRunStatus,
      runId: sr.runId,
      observations: sr.observations,
      stanceJudged: sr.stanceJudged,
      costUsd: sr.costUsd,
      failureKind: sr.failureKind,
      error: sr.error,
    }));

    // ── Judged ────────────────────────────────────────────────────────────
    const judgeAvailable = stances.length > 0;
    // The model recorded on the stance rows is the one that actually ran.
    const judgeModelUsed = judgeAvailable
      ? (
          await this.prisma.aeoStance.findFirst({
            where: { auditId },
            orderBy: { createdAt: 'desc' },
            select: { judgeModel: true },
          })
        )?.judgeModel ?? 'unknown'
      : undefined;
    const stanceCounts = this.emptyStanceCounts();
    for (const s of stances) stanceCounts[s.stance]++;

    const losing = stances
      .filter((s) => s.losesTo.length > 0)
      .sort((a, b) => b.losesTo.length - a.losesTo.length)
      .slice(0, 25)
      .map((s) => ({
        prompt: observations.find((o) => o.id === s.observationId)?.prompt ?? '',
        dimension: s.dimension,
        losesTo: s.losesTo,
        evidenceQuote: s.evidenceQuote,
      }));

    const winning = stances
      .filter((s) => s.stance === 'recommended-primary' || s.recommendedOver.length > 0)
      .slice(0, 25)
      .map((s) => ({
        prompt: observations.find((o) => o.id === s.observationId)?.prompt ?? '',
        dimension: s.dimension,
        recommendedOver: s.recommendedOver,
        evidenceQuote: s.evidenceQuote,
      }));

    const verdict: AeoVerdict = {
      surface: audit.surface,
      surfaceRuns: surfaceRunResults,
      runCount: audit.runCount,
      generatedAt: new Date().toISOString(),
      counted: {
        overall,
        unbranded,
        branded,
        byDimension,
        byFunnelStage,
        shareOfVoice: summary.shareOfVoice,
        competitors,
        bySurface,
        // Only meaningful once the audit measured more than one market — a
        // plain single-market audit gets a one-item (or empty, on legacy
        // pre-D8 rows) array here, never a redundant duplicate of `overall`.
        byMarket,
        byMarketSurface,
        byMarketCompetitors,
      },
      judged: {
        available: judgeAvailable,
        ...(judgeAvailable
          ? // Read back from the rows themselves — that is the model which
            // actually produced these judgements. Deriving it from config would
            // name whatever is configured *now*, which is wrong for any audit
            // judged before the setting changed, and wrong for every audit if
            // the configured provider is not the one that ran.
            { judgeModel: judgeModelUsed }
          : {
              unavailableReason: this.stance.isAvailable()
                ? 'stance pass has not been run for this audit'
                : 'no LLM provider is configured (OPENROUTER_API_KEY / ANTHROPIC_API_KEY) — ' +
                  'counted metrics are unaffected',
            }),
        observationsJudged: stances.length,
        stanceCounts,
        losingPrompts: losing,
        winningPrompts: winning,
      },
      headlines: [],
    };

    verdict.headlines = this.headlines(verdict);
    return verdict;
  }

  /** Counted metrics for a slice of observations. */
  private metrics(rows: Array<{ prompt: string; mentioned: boolean; cited: boolean }>): SliceMetrics {
    const observations = rows.length;
    const prompts = new Set(rows.map((r) => r.prompt)).size;
    if (observations === 0) return { prompts, observations: 0, mentionRate: 0, citationRate: 0 };
    return {
      prompts,
      observations,
      mentionRate: Number((rows.filter((r) => r.mentioned).length / observations).toFixed(4)),
      citationRate: Number((rows.filter((r) => r.cited).length / observations).toFixed(4)),
    };
  }

  /**
   * Per-competitor standing: counted co-occurrence plus judged head-to-head
   * outcomes, with the two kept in separate fields.
   */
  private competitorStandings(
    rows: Array<{ prompt: string; mentioned: boolean; competitors: string[] }>,
    stances: StanceVerdict[],
    stanceByObs: Map<string, StanceVerdict>,
    observations: Array<{ id: string; prompt: string; mentioned: boolean; competitors: string }>,
  ): CompetitorStanding[] {
    const total = rows.length || 1;
    const names = new Set<string>();
    for (const row of rows) for (const c of row.competitors) names.add(c);
    for (const s of stances) for (const c of [...s.losesTo, ...s.recommendedOver]) names.add(c);

    return [...names]
      .map((name) => {
        const seen = rows.filter((r) => r.competitors.includes(name));
        const ahead = stances.filter((s) => s.recommendedOver.includes(name)).length;
        const behind = stances.filter((s) => s.losesTo.includes(name)).length;
        const wonAlone = observations.filter((o) => {
          const comps = this.parseArray(o.competitors);
          const judged = stanceByObs.get(o.id);
          const clientAbsent = judged ? judged.stance === 'absent' : !o.mentioned;
          return comps.includes(name) && clientAbsent;
        }).length;

        return {
          name,
          observations: seen.length,
          mentionRate: Number((seen.length / total).toFixed(4)),
          clientAheadCount: ahead,
          clientBehindCount: behind,
          wonWhileClientAbsent: wonAlone,
        };
      })
      .sort((a, b) => b.observations - a.observations || b.clientBehindCount - a.clientBehindCount);
  }

  /**
   * Plain-language summary lines. Facts only — each is either a counted rate or
   * an explicitly labelled judged count, so the copy can be quoted as-is.
   */
  private headlines(v: AeoVerdict): string[] {
    const pct = (n: number): string => (n * 100).toFixed(0) + '%';
    const out: string[] = [];

    const measured = v.counted.bySurface.filter((s) => s.status === 'completed' && s.observations > 0);
    const engines = measured.map((s) => s.label).join(', ') || v.surface;

    out.push(
      `Named in ${pct(v.counted.overall.mentionRate)} of ${v.counted.overall.observations} answers across ` +
        `${measured.length || 1} engine${measured.length === 1 ? '' : 's'} (${engines}), n=${v.runCount} per prompt.`,
    );

    // The comparison is the point of measuring more than one engine: a spread
    // between them is a different problem from being weak everywhere.
    if (measured.length > 1) {
      const ranked = [...measured].sort((a, b) => b.unbrandedMentionRate - a.unbrandedMentionRate);
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      if (best.unbrandedMentionRate === 0) {
        out.push(`Invisible on every engine measured for unbranded prompts (${engines}).`);
      } else if (best.unbrandedMentionRate - worst.unbrandedMentionRate >= 0.05) {
        out.push(
          `Uneven across engines: ${pct(best.unbrandedMentionRate)} on ${best.label} vs ` +
            `${pct(worst.unbrandedMentionRate)} on ${worst.label} (unbranded prompts).`,
        );
      } else {
        out.push(
          `Consistent across engines: ${pct(worst.unbrandedMentionRate)}-${pct(best.unbrandedMentionRate)} ` +
            `on unbranded prompts.`,
        );
      }
    }

    // A dead engine is a finding, not a gap to paper over.
    const dead = v.surfaceRuns.filter((s) => s.status === 'failed');
    if (dead.length > 0) {
      out.push(
        'Not measured: ' +
          dead.map((s) => `${s.label} (${s.failureKind ?? 'failed'})`).join(', ') +
          ' — those engines are absent from every number above.',
      );
    }

    if (v.counted.unbranded.observations > 0) {
      out.push(
        `On the ${v.counted.unbranded.observations} answers to prompts that never mention the brand — ` +
          `the real visibility test — the mention rate is ${pct(v.counted.unbranded.mentionRate)}.`,
      );
    }

    const worstDimension = [...v.counted.byDimension]
      .filter((d) => d.observations >= 5)
      .sort((a, b) => a.mentionRate - b.mentionRate)[0];
    if (worstDimension) {
      out.push(
        `Weakest category: ${worstDimension.label} — ${pct(worstDimension.mentionRate)} across ` +
          `${worstDimension.observations} answers.`,
      );
    }

    const losing = v.counted.competitors.filter((c) => c.wonWhileClientAbsent > 0).slice(0, 3);
    if (losing.length > 0) {
      out.push(
        'Named while the client was not: ' +
          losing.map((c) => `${c.name} (${c.wonWhileClientAbsent} answers)`).join(', ') + '.',
      );
    }

    if (v.judged.available) {
      const led = v.judged.stanceCounts['recommended-primary'];
      const negative = v.judged.stanceCounts['mentioned-negative'];
      out.push(
        `Judged (LLM, not a measured rate): led the answer ${led} times, ` +
          `carried a caveat ${negative} times, across ${v.judged.observationsJudged} judged answers.`,
      );
      if (v.judged.losingPrompts.length > 0) {
        out.push(
          `${v.judged.losingPrompts.length} answers placed a named competitor above the client — ` +
            'each carries a verbatim quote in `judged.losingPrompts`.',
        );
      }
    } else {
      out.push('Competitive stance was not judged: ' + (v.judged.unavailableReason ?? 'unavailable') + '.');
    }

    return out;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Operator-facing hint for the commonest cause of a dead engine. */
  private surfaceHint(surface: string): string {
    if (surface.startsWith('cloro-')) {
      return 'Check CLORO_API_KEY is set and the account has remaining credits (GET /v1/credits).';
    }
    const envPrefix = surface.startsWith('perplexity')
      ? 'AEO_PERPLEXITY'
      : surface.startsWith('gemini')
        ? 'AEO_GEMINI'
        : 'AEO_CHATGPT';
    return (
      `Check AEO_ALLOW_BROWSER_SURFACE=1 and that ${envPrefix}_SESSION_PATH points at a valid, ` +
      `unexpired session. Re-run with AEO_BROWSER_HEADLESS=0 to watch what the page does.`
    );
  }

  /**
   * Bucket a failure message into the adapter's typed reasons so the report can
   * say *why* an engine produced nothing — "blocked" and "we never turned it on"
   * are very different findings.
   */
  private classifyFailure(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('cloro_api_key')) return 'cloro-disabled';
    if (m.includes('insufficient_credits') || m.includes('insufficient credits')) return 'cloro-budget-exceeded';
    if (m.includes('did not finish within')) return 'cloro-timeout';
    if (m.includes('task') && m.includes('failed')) return 'cloro-task-failed';
    if (m.includes('disabled')) return 'surface-disabled';
    if (m.includes('session file not found') || m.includes('session_path')) return 'no-session';
    if (m.includes('signed out') || m.includes('session-expired')) return 'session-expired';
    if (m.includes('challenge') || m.includes('human')) return 'challenged';
    if (m.includes('rate limit') || m.includes('too many')) return 'rate-limited';
    if (m.includes('blocked') || m.includes('access denied')) return 'blocked';
    if (m.includes('composer') || m.includes('selector')) return 'selector-drift';
    if (m.includes('timed out') || m.includes('timeout')) return 'timeout';
    return 'unknown';
  }

  /**
   * Pre-flight check: does the remaining Cloro credit balance cover this
   * surface's run? Uses the flat, disclosed per-task rate as an *estimate* —
   * the real charge always comes from `creditsCharged` after the fact — so a
   * run is refused up front rather than burning most of the allowance and
   * stopping half way (wave-6 D1/Step 1).
   */
  /**
   * What a run would cost, answered before it starts.
   *
   * The run-time guard below ({@link cloroFitsBudget}) already refuses a run
   * that cannot finish inside the allowance — but by then the operator has
   * already committed. This is the same arithmetic, exposed while they are
   * still choosing a tier, which is the piece step 0 deferred until step 1 gave
   * credits a meaning.
   *
   * Never throws on an unreadable balance: `remaining` and `fits` come back
   * null with the reason stated. An unknown balance is not a sufficient one and
   * not an insufficient one, and reporting either would be a guess.
   *
   * @param surfaces Engines the operator has selected.
   * @param prompts Prompt count for the chosen tier.
   * @param runCount Repeats per prompt (n>=5).
   * @param markets How many markets the run covers (>=1).
   */
  async estimateBudget(
    surfaces: AeoSurface[],
    prompts: number,
    runCount: number,
    markets: number,
  ): Promise<AeoBudgetEstimate> {
    const safePrompts = Math.max(prompts, 0);
    const safeRuns = Math.max(runCount, 1);
    const safeMarkets = Math.max(markets, 1);

    const perSurface = surfaces.map((surface) => {
      const perTask = CLORO_BASE_CREDITS[surface as CloroSurface];
      const metered = perTask !== undefined;
      return {
        surface,
        label: SURFACE_LABELS[surface] ?? surface,
        // Browser surfaces cost no credits — they are paid for by the
        // operator's own subscription. Reporting a made-up number for them
        // would corrupt the total the whole guard depends on.
        credits: metered ? perTask * safePrompts * safeRuns * safeMarkets : 0,
        metered,
      };
    });

    const required = perSurface.reduce((sum, r) => sum + r.credits, 0);
    const calls = safePrompts * safeRuns * surfaces.length * safeMarkets;

    // Only ask Cloro for a balance when something in this run would spend one.
    if (required === 0) {
      return {
        required: 0,
        remaining: null,
        fits: true,
        unavailableReason: null,
        perSurface,
        calls,
        prompts: safePrompts,
        runCount: safeRuns,
        markets: safeMarkets,
      };
    }

    try {
      const remaining = await this.cloro.getRemainingCredits();
      return {
        required,
        remaining,
        fits: required <= remaining,
        unavailableReason: null,
        perSurface,
        calls,
        prompts: safePrompts,
        runCount: safeRuns,
        markets: safeMarkets,
      };
    } catch (err) {
      return {
        required,
        remaining: null,
        fits: null,
        unavailableReason: (err as Error).message,
        perSurface,
        calls,
        prompts: safePrompts,
        runCount: safeRuns,
        markets: safeMarkets,
      };
    }
  }

  private async cloroFitsBudget(
    surface: string,
    promptCount: number,
    runCount: number,
  ): Promise<{ ok: true } | { ok: false; reason: string; failureKind: string }> {
    const perTask = CLORO_BASE_CREDITS[surface as CloroSurface];
    if (perTask === undefined) return { ok: true }; // not a Cloro surface
    const estimate = perTask * Math.max(promptCount, 1) * Math.max(runCount, 1);
    try {
      const remaining = await this.cloro.getRemainingCredits();
      if (estimate > remaining) {
        return {
          ok: false,
          failureKind: 'cloro-budget-exceeded',
          reason: `Estimated ${estimate} credits needed (${promptCount} prompts × ${runCount} runs × ${perTask}/task) but only ${remaining} remain.`,
        };
      }
      return { ok: true };
    } catch (err) {
      // A CloroAdapterError already names the specific reason (disabled,
      // api-error, ...) — surfacing it here means "we never turned it on" and
      // "we ran out of credits" stay distinguishable, which is the entire
      // point of a typed failureKind (see classifyFailure above).
      const failureKind = err instanceof CloroAdapterError ? err.reason : 'cloro-api-error';
      return { ok: false, failureKind, reason: (err as Error).message };
    }
  }

  private emptyStanceCounts(): Record<Stance, number> {
    return STANCES.reduce(
      (acc, s) => {
        acc[s] = 0;
        return acc;
      },
      {} as Record<Stance, number>,
    );
  }

  private parseVerdict(raw: string | null): AeoVerdict | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AeoVerdict;
    } catch {
      return null;
    }
  }

  private parseMeta(raw: string | null): PromptMeta | null {
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as PromptMeta) : null;
    } catch {
      return null;
    }
  }

  private parseArray(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private asDimension(raw: string | null): PromptDimension | null {
    return raw && (PROMPT_DIMENSIONS as readonly string[]).includes(raw) ? (raw as PromptDimension) : null;
  }

  private defaultTier(): MatrixTier {
    const raw = this.config.get<string>('AEO_MATRIX_TIER', 'standard');
    return raw in TIER_SIZES ? (raw as MatrixTier) : 'standard';
  }

  private costCap(): number {
    return Number(this.config.get<string>('AEO_MAX_COST_PER_AUDIT', '10.00'));
  }
}
