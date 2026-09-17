/**
 * AEO Visibility Service — the read composition behind the merged "AI
 * visibility" screen (platform_improvement_plan.md §8, P13).
 *
 * These reads are composed for that screen; the routes stay on the staff
 * `projects/:projectId/aeo` controller (no `@ClientPortal()`), so merging the
 * prompt-detail page into this one does not put anything new in front of a
 * client account. In particular no read here selects `Observation.rawAnswer` —
 * question text and counted results yes, verbatim model output no (§8.1).
 *
 * Reuses `aeo-audit`'s audit/verdict lifecycle, `aeo-matrix`'s versioned
 * QuerySet, and `measurement`'s Observation rows. Adds no new measurement and
 * no new storage — this is composition over what those three already record.
 *
 * Three reads, matching the merged screen's three views:
 * - {@link summary} — score/mention-rate where valid, questions-checked count,
 *   locations, dates, plain-English status (§8.1 Summary).
 * - {@link questions} — question-level aggregate, paginated, grouped by topic,
 *   with the current query-set version stamped on every page (§8.1 Customer
 *   questions, §8.4).
 * - {@link history} — comparable measurements across audits, with an explicit
 *   comparability-break flag whenever the underlying question-set version
 *   changed (§8.2's "never silently keep a chart continuous").
 *
 * Denominator truth (§8.4, the P13 exit gate): every surface/market this audit
 * attempted is named here, including failed and gated ones — never dropped to
 * flatter an average. A question with zero observations reports `checked:
 * false` ("Not checked"), never a fabricated zero-appearance count.
 *
 * @module aeo-visibility.service
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AeoAuditService } from './aeo-audit.service';
import { AeoMatrixService } from './aeo-matrix.service';
import { DIMENSION_LABELS, SURFACE_LABELS } from './aeo-audit.types';
import type { AeoSurface, PromptDimension, PromptMeta, Stance } from './aeo-audit.types';
import type {
  CustomerQuestion,
  CustomerQuestionsPage,
  QuestionObservationResult,
  VisibilityHistoryEntry,
  VisibilityMethodology,
  VisibilitySummary,
} from './aeo-visibility.types';

const RECOMMENDED_STANCES: readonly Stance[] = ['recommended-primary', 'recommended-alternative'];

function accessMode(surface: string): 'api' | 'browser-automation' | 'test-only' {
  if (surface === 'mock') return 'test-only';
  if (surface.endsWith('-browser')) return 'browser-automation';
  return 'api';
}

function parseMarkets(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

@Injectable()
export class AeoVisibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audits: AeoAuditService,
    private readonly matrix: AeoMatrixService,
  ) {}

  /**
   * The audit this read composes from: the given id, or the most recent one a
   * client is owed an account of.
   *
   * Default resolution prefers the newest *completed* measurement, then falls
   * back to the newest *failed* one. A failed attempt is still something the
   * client must be told about — "we checked these engines in these locations and
   * no answers came back" is a reportable fact, and hiding it behind a
   * "nothing here yet" empty state is the same dishonesty as dropping a gated
   * engine from the denominator (§8.4). A `pending`/in-flight audit deliberately
   * does NOT resolve: there is genuinely nothing to report yet.
   */
  private async resolveAudit(projectId: string, auditId?: string) {
    if (auditId) {
      const audit = await this.audits.get(auditId);
      if ((audit as { projectId: string }).projectId !== projectId) {
        throw new NotFoundException('Audit not found: ' + auditId + ' for project ' + projectId);
      }
      return audit;
    }
    for (const status of ['completed', 'failed'] as const) {
      const latest = await this.prisma.aeoAudit.findFirst({
        where: { projectId, status },
        orderBy: { createdAt: 'desc' },
      });
      if (latest) return this.audits.get(latest.id);
    }
    throw new NotFoundException(
      'No AI-visibility measurement for project ' + projectId + ' — run an audit first.',
    );
  }

  /** Failed/gated surfaces, named — never silently dropped from the denominator disclosure. */
  private disclosedFailures(
    surfaceRuns: Array<{ surface: string; market: string | null; status: string; failureKind: string | null; error: string | null }>,
  ) {
    return surfaceRuns
      .filter((run) => run.status === 'failed' || run.status === 'skipped')
      .map((run) => ({
        surface: run.surface as AeoSurface,
        label: SURFACE_LABELS[run.surface as AeoSurface] ?? run.surface,
        market: run.market,
        reason: run.failureKind ?? run.error ?? `Surface reported no answers (status: ${run.status}).`,
      }));
  }

  private methodology(audit: {
    querySetId: string | null;
    tier: string;
    runCount: number;
    markets: string;
    surfaceRuns: Array<{ surface: string; market: string | null; status: string; failureKind: string | null }>;
  }, querySetVersion: number): VisibilityMethodology {
    return {
      surfaces: audit.surfaceRuns.map((run) => ({
        surface: run.surface as AeoSurface,
        label: SURFACE_LABELS[run.surface as AeoSurface] ?? run.surface,
        status: run.status as never,
        market: run.market,
        accessMode: accessMode(run.surface),
        failureKind: run.failureKind,
      })),
      questionSetVersion: querySetVersion,
      questionSetId: audit.querySetId ?? '',
      samplingConfig: { tier: audit.tier, runCount: audit.runCount },
      markets: parseMarkets(audit.markets),
    };
  }

  // ─── Summary (§8.1) ────────────────────────────────────────────────────

  async summary(projectId: string, auditId?: string): Promise<VisibilitySummary> {
    const audit = await this.resolveAudit(projectId, auditId);
    if (!audit.querySetId) {
      throw new BadRequestException('Audit ' + audit.id + ' has no matrix — nothing to summarize.');
    }
    // §8.4's honesty rule applies to the whole summary, not only to a single
    // question: an audit that produced no answers has no verdict, and
    // `buildVerdict` refuses with "has not measured anything yet". Reporting
    // that as a 400 would put an error in front of a client whose real answer is
    // "nothing has been checked" — so every verdict-derived figure below carries
    // an explicit empty fallback instead of throwing.
    const measuredSomething =
      audit.surfaceRuns.some((run) => Boolean(run.runId) && run.status === 'completed') ||
      Boolean((audit as { runId?: string | null }).runId);
    const verdict = audit.verdict ?? (measuredSomething ? await this.audits.verdict(audit.id) : null);
    const matrixSummary = await this.matrix.summary(audit.querySetId);

    // Distinct questions actually measured, from stored Observations — never
    // derived from the matrix's prompt count, which would count unattempted
    // prompts as if they had an answer.
    const runIds = audit.surfaceRuns.map((r) => r.runId).filter((id): id is string => Boolean(id));
    const itemIds = matrixSummary.byDimension.flatMap((d) => d.prompts.map((p) => p.id));
    const checkedGroups = runIds.length
      ? await this.prisma.observation.groupBy({
          by: ['itemId'],
          where: { runId: { in: runIds }, itemId: { in: itemIds } },
          _count: { _all: true },
          _max: { mentioned: true },
        })
      : [];
    const questionsChecked = checkedGroups.length;
    const appearedQuestions = checkedGroups.filter((g) => g._max.mentioned === true).length;

    const disclosedFailures = this.disclosedFailures(audit.surfaceRuns);
    const totalAnswers = verdict?.counted.overall.observations ?? 0;
    const appearedRateValid = totalAnswers > 0;
    // Raw counts, queried directly rather than backed out of the stored rate —
    // `mentionRate * observations` would round, and a headline count must be exact.
    const appearedAnswers = totalAnswers
      ? await this.prisma.observation.count({ where: { runId: { in: runIds }, itemId: { in: itemIds }, mentioned: true } })
      : 0;

    const stanceRows =
      verdict?.judged.available && runIds.length
        ? await this.prisma.aeoStance.findMany({
            where: { auditId: audit.id },
            select: { stance: true, observationId: true },
          })
        : null;
    const recommended = stanceRows
      ? {
          count: stanceRows.filter((s) => RECOMMENDED_STANCES.includes(s.stance as Stance)).length,
          of: stanceRows.length,
          rateValid: stanceRows.length > 0,
        }
      : null;

    const markets = parseMarkets(audit.markets);
    const period = { startedAt: audit.startedAt?.toISOString() ?? null, finishedAt: audit.finishedAt?.toISOString() ?? null };

    const headline = appearedRateValid
      ? `Your business appeared in ${appearedAnswers} of ${totalAnswers} answers we checked` +
        (markets.length ? ` in ${markets.join(', ')}` : '') +
        (period.finishedAt ? ` (checked ${period.finishedAt.slice(0, 10)})` : '') +
        '.'
      : 'No answers have been checked yet for this project — nothing to report until a measurement run completes.';

    // When nothing came back there is no verdict, so the summary states the
    // failures it is counting over — in the same shape §8.4 requires for the
    // denominator — instead of leaving the client with an unexplained blank.
    const headlines = verdict?.headlines ?? [];
    if (!verdict && disclosedFailures.length > 0) {
      headlines.push(
        'Nothing was measured: ' +
          disclosedFailures
            .map((f) => f.label + (f.market ? ' (' + f.market + ')' : ''))
            .join(', ') +
          ' did not return a usable answer.',
      );
    }

    return {
      auditId: audit.id,
      status: audit.status,
      generatedAt: verdict?.generatedAt ?? audit.finishedAt?.toISOString() ?? null,
      period,
      markets,
      headline,
      appeared: {
        count: appearedQuestions,
        of: questionsChecked,
        rateValid: questionsChecked > 0,
      },
      recommended,
      questionsChecked,
      totalQuestions: matrixSummary.promptCount,
      disclosedFailures,
      methodology: this.methodology(audit, matrixSummary.version),
      headlines,
    };
  }

  // ─── Customer questions (§8.1, §8.4) ──────────────────────────────────

  async questions(
    projectId: string,
    opts: { auditId?: string; topic?: PromptDimension; cursor?: string; limit?: number },
  ): Promise<CustomerQuestionsPage> {
    const audit = await this.resolveAudit(projectId, opts.auditId);
    if (!audit.querySetId) {
      throw new BadRequestException('Audit ' + audit.id + ' has no matrix — nothing to compose.');
    }
    const matrixSummary = await this.matrix.summary(audit.querySetId);
    const allItems = matrixSummary.byDimension
      .filter((d) => !opts.topic || d.dimension === opts.topic)
      .flatMap((d) => d.prompts)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const startIndex = opts.cursor ? allItems.findIndex((p) => p.id === opts.cursor) + 1 : 0;
    const pageItems = allItems.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const hasMore = nextIndex < allItems.length;
    const nextCursor = hasMore ? allItems[nextIndex - 1]?.id ?? null : null;

    const runMap = new Map(
      audit.surfaceRuns
        .filter((r) => r.runId)
        .map((r) => [r.runId as string, r]),
    );
    const runIds = [...runMap.keys()];
    const itemIds = pageItems.map((p) => p.id);

    // `citedUrl` is the public source the answer pointed at — §8.1's "safe
    // explanation/source reference". `rawAnswer` is deliberately NOT selected
    // here, and must not be: that is the staff-only record and this read is
    // what the merged screen renders.
    const observations = itemIds.length && runIds.length
      ? await this.prisma.observation.findMany({
          where: { itemId: { in: itemIds }, runId: { in: runIds } },
          select: { id: true, itemId: true, runId: true, mentioned: true, cited: true, citedUrl: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const observationIds = observations.map((o) => o.id);
    const stances = observationIds.length
      ? await this.prisma.aeoStance.findMany({
          where: { auditId: audit.id, observationId: { in: observationIds } },
          select: { observationId: true, stance: true },
        })
      : [];
    const stanceByObs = new Map(stances.map((s) => [s.observationId, s.stance as Stance]));

    const obsByItem = new Map<string, typeof observations>();
    for (const obs of observations) {
      const bucket = obsByItem.get(obs.itemId);
      if (bucket) bucket.push(obs);
      else obsByItem.set(obs.itemId, [obs]);
    }

    const items: CustomerQuestion[] = pageItems.map((p) => {
      const meta = p.meta as PromptMeta | null;
      const obsForItem = obsByItem.get(p.id) ?? [];
      const results: QuestionObservationResult[] = obsForItem.map((o) => {
        const run = runMap.get(o.runId);
        return {
          surface: (run?.surface as AeoSurface) ?? 'mock',
          label: SURFACE_LABELS[(run?.surface as AeoSurface) ?? 'mock'] ?? run?.surface ?? 'Unknown',
          attemptedVia: (run?.attemptedVia as AeoSurface | null) ?? null,
          market: run?.market ?? null,
          mentioned: o.mentioned,
          cited: o.cited,
          // Only ever a URL the answer actually cited. A cited-but-unrecorded
          // URL stays null rather than being guessed at from the domain.
          sourceUrl: o.cited ? (o.citedUrl ?? null) : null,
          stance: stanceByObs.get(o.id) ?? null,
          checkedAt: o.createdAt.toISOString(),
        };
      });
      const hasAnyStance = results.some((r) => r.stance !== null);
      return {
        id: p.id,
        prompt: p.prompt,
        topic: p.dimension,
        topicLabel: p.dimension ? DIMENSION_LABELS[p.dimension] : 'Uncategorized',
        funnelStage: p.funnelStage,
        branding: meta?.branding ?? null,
        checked: obsForItem.length > 0,
        attempts: obsForItem.length,
        appearedCount: results.filter((r) => r.mentioned).length,
        recommendedCount: hasAnyStance ? results.filter((r) => r.stance && RECOMMENDED_STANCES.includes(r.stance)).length : null,
        checkedAt: results.length ? results[results.length - 1].checkedAt : null,
        results,
      };
    });

    return {
      auditId: audit.id,
      querySetId: matrixSummary.querySetId,
      querySetVersion: matrixSummary.version,
      querySetStatus: matrixSummary.status,
      topic: opts.topic ?? null,
      items,
      pageInfo: { total: allItems.length, nextCursor, hasMore },
    };
  }

  // ─── History (§8.2 comparability break) ───────────────────────────────

  async history(projectId: string): Promise<VisibilityHistoryEntry[]> {
    const audits = await this.prisma.aeoAudit.findMany({
      where: { projectId, status: { in: ['completed', 'failed'] } },
      orderBy: { createdAt: 'asc' },
      include: { surfaceRuns: { orderBy: { createdAt: 'asc' } } },
    });

    const entries: VisibilityHistoryEntry[] = [];
    let previousQuerySetId: string | null = null;
    let previousVersion: number | null = null;

    for (const audit of audits) {
      if (!audit.querySetId) continue;
      const matrixSummary = await this.matrix.summary(audit.querySetId).catch(() => null);
      if (!matrixSummary) continue;

      const runIds = audit.surfaceRuns.map((r) => r.runId).filter((id): id is string => Boolean(id));
      const itemIds = matrixSummary.byDimension.flatMap((d) => d.prompts.map((p) => p.id));
      const checkedGroups = runIds.length
        ? await this.prisma.observation.groupBy({
            by: ['itemId'],
            where: { runId: { in: runIds }, itemId: { in: itemIds } },
            _max: { mentioned: true },
          })
        : [];
      const questionsChecked = checkedGroups.length;
      const appearedQuestions = checkedGroups.filter((g) => g._max.mentioned === true).length;

      const versionChanged =
        previousQuerySetId !== null &&
        (audit.querySetId !== previousQuerySetId || matrixSummary.version !== previousVersion);
      const comparabilityBreak = previousQuerySetId !== null && versionChanged;

      entries.push({
        auditId: audit.id,
        querySetId: matrixSummary.querySetId,
        querySetVersion: matrixSummary.version,
        generatedAt: audit.startedAt?.toISOString() ?? audit.createdAt.toISOString(),
        finishedAt: audit.finishedAt?.toISOString() ?? null,
        markets: parseMarkets(audit.markets),
        status: audit.status,
        questionsChecked,
        totalQuestions: matrixSummary.promptCount,
        // §8.4: nothing checked is "Not checked", never a 0-of-0 rate.
        appeared: questionsChecked > 0 ? { count: appearedQuestions, of: questionsChecked } : null,
        comparabilityBreak,
        comparabilityNote: comparabilityBreak
          ? `Question set changed to v${matrixSummary.version} (${matrixSummary.querySetId === previousQuerySetId ? 'same set, new version' : 'different set'}) — not directly comparable with earlier history. Wording, topic or market coverage may have changed.`
          : null,
        disclosedFailures: this.disclosedFailures(audit.surfaceRuns),
      });

      previousQuerySetId = audit.querySetId;
      previousVersion = matrixSummary.version;
    }

    // Newest first for the history view; comparability notes read forward
    // ("changed to vN") but display in reverse-chronological order like every
    // other history list in the product.
    return entries.reverse();
  }
}
