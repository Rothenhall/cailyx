/**
 * EvidenceService — G13's evidence manifests.
 *
 * An `EvidenceManifest` answers one question for one window: *which exact rows
 * was this snapshot built from?* It pins ids, records per-source coverage
 * (expected / succeeded / failed / pending), records the **real** timestamp
 * each source carries, and names what was expected but absent.
 *
 * Three rules are implemented here rather than described:
 *
 * - **Freshness is not the period end.** {@link buildFreshness} keeps the
 *   newest real source date and the window's own end in two different fields
 *   and states their relationship. A surface that renders "updated" from the
 *   source date is rendering the source date; the period end is a separate
 *   value it must ask for by name.
 * - **Pending and failed are disclosed.** Every collection that started and
 *   did not finish, and every one that failed, appears in `coverage` and in
 *   the returned `pending`/`failed` lists with its reason. Nothing is dropped
 *   for being incomplete (§6.4: "failed fetch is never 'no issue found'").
 * - **A large source pins a prefix, and says so.** Pinning ten thousand
 *   crawler-hit ids would make the manifest unreadable; pinning five hundred
 *   silently would make it a lie. So it pins up to
 *   {@link EVIDENCE_PIN_LIMIT} and names the truncation in `truncations`.
 *
 * @module evidence.service
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type {
  EvidenceBundleView,
  EvidenceCoverage,
  EvidenceFreshness,
  EvidenceManifestView,
  EvidenceSourceType,
  ObservationDisclosure,
  ResultsWindow,
} from './results.types';
import { EVIDENCE_PIN_LIMIT } from './results.types';
import { daysBetween, parseJson, parseRecord, parseStringArray, sanitizeReason } from './results.util';
import type { CreateManifestDto } from './dto/results.dto';

/** How one source row counts toward coverage. */
type RowOutcome = 'succeeded' | 'failed' | 'pending';

/** A source row reduced to what the manifest needs. */
interface SourceRow {
  id: string;
  at: Date | null;
  outcome: RowOutcome;
  reason?: string;
  status?: string;
  detail?: string;
}

/** Raw numbers the metric layer reads off the same collection pass. */
export interface CollectedCounts {
  observations: {
    total: number;
    mentioned: number;
    cited: number;
    prompts: number;
    distinctEngines: number;
    maxRepeats: number;
  };
  shareOfVoice: {
    clientPresence: number;
    competitorPresence: number;
    trackedCompetitors: number;
    untrackedNames: number;
  };
  crawlerHits: { total: number; distinctVendors: number; byType: Record<string, number>; everIngested: number };
  referringDomains: { value: number | null; capturedAt: string; status: string } | null;
  coverage: { expected: number; succeeded: number; failed: number; pending: number };
  score: { id: string; total: number; band: string; rubricVersion: number; status: string; at: string } | null;
}

/** Everything one collection pass produced. */
export interface CollectedEvidence {
  bundle: Omit<EvidenceBundleView, 'manifestId' | 'pinned'>;
  counts: CollectedCounts;
  pending: ObservationDisclosure[];
  failed: ObservationDisclosure[];
}

@Injectable()
export class EvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read a project's measurement, scoring, audit, presence, authority,
   * backlink, crawler, competitor, content and work rows for one window, and
   * reduce them to a manifest bundle plus the counts the metrics need.
   *
   * One pass, not two: metrics and evidence must be computed from the *same*
   * rows, or a snapshot could report a rate that its own manifest does not
   * cover.
   */
  async collect(projectId: string, window: ResultsWindow, pinnedScoreRunId?: string): Promise<CollectedEvidence> {
    const from = new Date(window.startsOn);
    const to = new Date(window.endsOn);
    const inWindow = { gte: from, lte: to };

    const [
      measurementRuns,
      observations,
      scoreRuns,
      aeoAudits,
      technicalAudits,
      seoAudits,
      presenceDiscoveries,
      authorityScans,
      backlinks,
      crawlerHits,
      competitors,
      contentBriefs,
      reports,
      workItems,
      attachments,
    ] = await Promise.all([
      this.prisma.measurementRun.findMany({
        where: { projectId },
        select: {
          id: true,
          status: true,
          error: true,
          createdAt: true,
          finishedAt: true,
          totalRequests: true,
          completedRequests: true,
          failedRequests: true,
        },
      }),
      this.prisma.observation.findMany({
        where: { createdAt: inWindow, run: { projectId } },
        select: { id: true, runId: true, createdAt: true, mentioned: true, cited: true, prompt: true, model: true, runNumber: true, competitors: true },
      }),
      this.prisma.scoreRun.findMany({ where: { projectId }, select: { id: true, total: true, band: true, rubricVersion: true, status: true, createdAt: true } }),
      this.prisma.aeoAudit.findMany({ where: { projectId }, select: { id: true, status: true, error: true, createdAt: true, finishedAt: true } }),
      this.prisma.technicalAudit.findMany({ where: { projectId }, select: { id: true, createdAt: true, pagesCrawled: true } }),
      this.prisma.seoAudit.findMany({ where: { projectId }, select: { id: true, createdAt: true, pagesInspected: true } }),
      this.prisma.presenceDiscovery.findMany({ where: { projectId }, select: { id: true, status: true, error: true, startedAt: true, finishedAt: true } }),
      this.prisma.authorityScan.findMany({ where: { projectId }, select: { id: true, status: true, error: true, note: true, createdAt: true, finishedAt: true } }),
      this.prisma.backlinksSummary.findMany({ where: { projectId }, select: { id: true, status: true, error: true, createdAt: true, referringDomains: true } }),
      this.prisma.crawlerHit.findMany({ where: { projectId }, select: { id: true, hitAt: true, botVendor: true, botType: true } }),
      this.prisma.competitor.findMany({ where: { projectId }, select: { id: true, name: true, status: true, createdAt: true } }),
      this.prisma.contentBrief.findMany({ where: { projectId }, select: { id: true, status: true, createdAt: true } }),
      this.prisma.report.findMany({ where: { projectId }, select: { id: true, status: true, visibility: true, createdAt: true } }),
      this.prisma.workItem.findMany({ where: { projectId }, select: { id: true, status: true, createdAt: true } }),
      this.prisma.attachment.findMany({ where: { projectId, deletedAt: null }, select: { id: true, createdAt: true } }),
    ]);

    // ── Reduce each source ────────────────────────────────────────────
    const runRows: SourceRow[] = measurementRuns.map((run) => ({
      id: run.id,
      at: run.finishedAt ?? run.createdAt,
      outcome: run.status === 'completed' ? 'succeeded' : run.status === 'failed' ? 'failed' : 'pending',
      status: run.status,
      reason: run.status === 'failed' ? sanitizeReason(run.error, 'The measurement run failed without recording a reason.') : undefined,
    }));

    // Observations pin their parent run, not themselves: a run id is the
    // reproducible unit (a single observation cannot be re-read without its
    // run), and pinning ten thousand observation ids would make the manifest
    // unreadable without making it more reproducible.
    const observationRunIds = Array.from(new Set(observations.map((o) => o.runId)));
    const observationRows: SourceRow[] = observationRunIds.map((id) => ({
      id,
      at: observations
        .filter((o) => o.runId === id)
        .reduce<Date | null>((latest, o) => (latest === null || o.createdAt > latest ? o.createdAt : latest), null),
      outcome: 'succeeded',
    }));

    const scoreRows: SourceRow[] = scoreRuns.map((run) => ({
      id: run.id,
      at: run.createdAt,
      outcome: 'succeeded',
      // `partial` is a real state on ScoreRun: evidence was missing and the
      // rubric marked a dimension partial rather than silently zeroing it.
      status: run.status,
      reason: run.status === 'partial' ? 'The score run was partial — at least one rubric dimension had missing evidence and contributed zero under the rubric.' : undefined,
    }));

    const aeoRows: SourceRow[] = aeoAudits.map((audit) => ({
      id: audit.id,
      at: audit.finishedAt ?? audit.createdAt,
      outcome: audit.status === 'completed' ? 'succeeded' : audit.status === 'failed' ? 'failed' : 'pending',
      status: audit.status,
      reason: audit.status === 'failed' ? sanitizeReason(audit.error, 'The AEO audit failed without recording a reason.') : undefined,
    }));

    const technicalRows: SourceRow[] = technicalAudits.map((audit) => ({
      id: audit.id,
      at: audit.createdAt,
      outcome: audit.pagesCrawled === 0 ? 'failed' : 'succeeded',
      status: audit.pagesCrawled === 0 ? 'empty' : 'complete',
      reason: audit.pagesCrawled === 0 ? 'The crawl completed without fetching a single page, so it contributed no page-level evidence.' : undefined,
    }));

    const seoRows: SourceRow[] = seoAudits.map((audit) => ({
      id: audit.id,
      at: audit.createdAt,
      outcome: audit.pagesInspected === 0 ? 'failed' : 'succeeded',
      status: audit.pagesInspected === 0 ? 'empty' : 'complete',
      reason: audit.pagesInspected === 0 ? 'The audit inspected 0 pages, so it contributed no Search Console page evidence.' : undefined,
    }));

    const presenceRows: SourceRow[] = presenceDiscoveries.map((row) => ({
      id: row.id,
      at: row.finishedAt ?? row.startedAt,
      outcome: row.status === 'completed' ? 'succeeded' : row.status === 'failed' ? 'failed' : 'pending',
      status: row.status,
      reason: row.status === 'failed' ? sanitizeReason(row.error, 'Presence discovery failed without recording a reason.') : undefined,
    }));

    const authorityRows: SourceRow[] = authorityScans.map((scan) => ({
      id: scan.id,
      at: scan.finishedAt ?? scan.createdAt,
      outcome: scan.status === 'complete' ? 'succeeded' : scan.status === 'running' ? 'pending' : 'failed',
      status: scan.status,
      reason:
        scan.status === 'partial' || scan.status === 'failed'
          ? sanitizeReason(scan.error ?? scan.note, `The authority scan ended ${scan.status}; its candidate set is incomplete.`)
          : undefined,
    }));

    const backlinkRows: SourceRow[] = backlinks.map((row) => ({
      id: row.id,
      at: row.createdAt,
      outcome: row.status === 'completed' ? 'succeeded' : row.status === 'pending' ? 'pending' : 'failed',
      status: row.status,
      reason: row.status === 'completed' ? undefined : sanitizeReason(row.error, `The backlinks snapshot ended ${row.status}, so it is a partial inventory.`),
    }));

    const crawlerRows: SourceRow[] = crawlerHits
      .filter((hit) => hit.hitAt >= from && hit.hitAt <= to)
      .map((hit) => ({ id: hit.id, at: hit.hitAt, outcome: 'succeeded' }));

    const competitorRows: SourceRow[] = competitors.map((row) => ({
      id: row.id,
      at: row.createdAt,
      outcome: 'succeeded',
      status: row.status,
    }));

    const contentRows: SourceRow[] = contentBriefs.map((row) => ({
      id: row.id,
      at: row.createdAt,
      outcome: 'succeeded',
      status: row.status,
    }));

    const reportRows: SourceRow[] = reports.map((row) => ({
      id: row.id,
      at: row.createdAt,
      outcome: 'succeeded',
      status: row.status,
    }));

    const workItemRows: SourceRow[] = workItems.map((row) => ({
      id: row.id,
      at: row.createdAt,
      outcome: 'succeeded',
      status: row.status,
    }));

    const attachmentRows: SourceRow[] = attachments.map((row) => ({
      id: row.id,
      at: row.createdAt,
      outcome: 'succeeded',
    }));

    // ── Build the bundle ──────────────────────────────────────────────
    const sources: Partial<Record<EvidenceSourceType, string[]>> = {};
    const coverage: Partial<Record<EvidenceSourceType, EvidenceCoverage>> = {};
    const sourceDates: Partial<Record<EvidenceSourceType, string>> = {};
    const omissions: string[] = [];
    const truncations: string[] = [];
    const pending: ObservationDisclosure[] = [];
    const failed: ObservationDisclosure[] = [];

    const record = (sourceType: EvidenceSourceType, rows: SourceRow[], note?: string): void => {
      const pinned = rows.slice(0, EVIDENCE_PIN_LIMIT);
      const succeeded = rows.filter((row) => row.outcome === 'succeeded').length;
      const failedRows = rows.filter((row) => row.outcome === 'failed');
      const pendingRows = rows.filter((row) => row.outcome === 'pending');
      const dates = rows.map((row) => row.at).filter((at): at is Date => at !== null).sort((a, b) => a.getTime() - b.getTime());

      sources[sourceType] = pinned.map((row) => row.id);
      coverage[sourceType] = {
        expected: rows.length,
        succeeded,
        failed: failedRows.length,
        pending: pendingRows.length,
        failedReason: failedRows.length > 0 ? describeFailures(failedRows) : null,
        pinnedCount: pinned.length,
        truncated: rows.length > EVIDENCE_PIN_LIMIT,
      };
      if (dates.length > 0) sourceDates[sourceType] = dates[dates.length - 1].toISOString();

      if (rows.length > EVIDENCE_PIN_LIMIT) {
        truncations.push(
          `${TRUNCATION_PREFIX}${sourceType}: ${rows.length} rows in the window; the first ${EVIDENCE_PIN_LIMIT} ids are pinned in this manifest. ` +
            'The counts and the window bounds are exact — only the id list is a prefix.',
        );
      }
      if (rows.length === 0 && note) omissions.push(`${ABSENCE_PREFIX}${sourceType}: ${note}`);

      for (const row of pendingRows) {
        pending.push({
          sourceType,
          id: row.id,
          status: row.status ?? 'pending',
          detail: row.reason ?? 'Started and has not reported yet.',
          observedAt: row.at ? row.at.toISOString() : null,
        });
      }
      for (const row of failedRows) {
        failed.push({
          sourceType,
          id: row.id,
          status: row.status ?? 'failed',
          detail: row.reason ?? 'Failed without recording a reason.',
          observedAt: row.at ? row.at.toISOString() : null,
        });
      }
    };

    record('measurement-run', runRows, 'no measurement run on this project');
    record('observation', observationRows, 'no observation falls inside this window');
    record('score-run', scoreRows, 'no rubric score run on this project');
    record('aeo-audit', aeoRows, 'no AEO audit on this project');
    record('technical-audit', technicalRows, 'no technical audit on this project');
    record('seo-audit', seoRows, 'no Search Console audit on this project');
    record('presence-discovery', presenceRows, 'digital-presence discovery has never run for this project');
    record('authority-scan', authorityRows, 'no authority scan on this project');
    record('backlinks-summary', backlinkRows, 'no backlinks snapshot on this project');
    record('crawler-hit', crawlerRows, 'no crawler hit was ingested inside this window');
    record('competitor', competitorRows, 'no competitors are tracked on this project');
    record('content-brief', contentRows, 'no content brief was created inside this window');
    record('report', reportRows, 'no report was created inside this window');
    record('work-item', workItemRows, 'no work item was created inside this window');
    record('attachment', attachmentRows, 'no attachment was uploaded inside this window');

    // AeoSurfaceRun is the per-surface detail *inside* an AeoAudit. It is
    // collected so a failed surface is visible even when the parent audit
    // reported success — the common case for a partially-performing engine.
    const aeoAuditIds = aeoAudits.map((audit) => audit.id);
    if (aeoAuditIds.length > 0) {
      const surfaceRuns = await this.prisma.aeoSurfaceRun.findMany({
        where: { auditId: { in: aeoAuditIds } },
        select: { id: true, surface: true, market: true, status: true, failureKind: true, error: true, finishedAt: true, createdAt: true },
      });
      record(
        'aeo-surface-run',
        surfaceRuns.map((row) => ({
          id: row.id,
          at: row.finishedAt ?? row.createdAt,
          outcome: row.status === 'completed' ? 'succeeded' : row.status === 'failed' || row.status === 'skipped' ? 'failed' : 'pending',
          status: row.status,
          reason:
            row.status === 'failed' || row.status === 'skipped'
              ? sanitizeReason(
                  row.error,
                  `${row.surface}${row.market ? ` / ${row.market}` : ''} ${row.status}${row.failureKind ? ` (${row.failureKind})` : ''}.`,
                )
              : undefined,
        })),
        'the AEO audits in this window recorded no per-surface run',
      );
    }

    // ── Score selection ───────────────────────────────────────────────
    const scoreInWindow = scoreRuns.filter((run) => run.createdAt >= from && run.createdAt <= to).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const scoreRow = pinnedScoreRunId
      ? scoreRuns.find((run) => run.id === pinnedScoreRunId) ?? null
      : scoreInWindow[0] ?? null;
    if (pinnedScoreRunId && !scoreRow) {
      throw new NotFoundException(`Score run ${pinnedScoreRunId} not found on project ${projectId}`);
    }

    // ── Real aggregation ──────────────────────────────────────────────
    const total = observations.length;
    const mentioned = observations.filter((o) => o.mentioned).length;
    const cited = observations.filter((o) => o.cited).length;
    const distinctEngines = new Set(observations.map((o) => o.model).filter((m): m is string => Boolean(m))).size;
    const maxRepeats = observations.reduce((max, o) => Math.max(max, o.runNumber), 0);

    const trackedNames = new Set(competitors.map((c) => c.name.trim().toLowerCase()));
    let competitorPresence = 0;
    const untracked = new Set<string>();
    for (const observation of observations) {
      for (const name of parseStringArray(observation.competitors)) {
        const key = name.trim().toLowerCase();
        if (trackedNames.has(key)) competitorPresence += 1;
        else if (key) untracked.add(key);
      }
    }

    const hitsInWindow = crawlerHits.filter((hit) => hit.hitAt >= from && hit.hitAt <= to);
    const byType: Record<string, number> = {};
    for (const hit of hitsInWindow) byType[hit.botType] = (byType[hit.botType] ?? 0) + 1;

    const latestBacklinks = backlinks.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;

    const expectedUnits = measurementRuns.reduce((sum, run) => sum + run.totalRequests, 0);
    const succeededUnits = measurementRuns.reduce((sum, run) => sum + run.completedRequests, 0);
    const failedUnits = measurementRuns.reduce((sum, run) => sum + run.failedRequests, 0);
    const pendingUnits = Math.max(0, expectedUnits - succeededUnits - failedUnits);

    const bundle: Omit<EvidenceBundleView, 'manifestId' | 'pinned'> = {
      sources,
      coverage,
      // The per-source dates live inside `freshness.perSource` (they are the
      // `sourceDates` column), so they are not duplicated at the top level.
      omissions,
      truncations,
      freshness: this.buildFreshness(window, sourceDates, rowsAt(runRows, scoreRows, technicalRows, seoRows, presenceRows, authorityRows, backlinkRows, crawlerRows, aeoRows)),
      scoreRunId: scoreRow?.id ?? null,
      rubricVersion: scoreRow ? String(scoreRow.rubricVersion) : null,
    };

    return {
      bundle,
      counts: {
        observations: {
          total,
          mentioned,
          cited,
          prompts: new Set(observations.map((o) => o.prompt)).size,
          distinctEngines,
          maxRepeats,
        },
        shareOfVoice: {
          clientPresence: mentioned,
          competitorPresence,
          trackedCompetitors: competitors.length,
          untrackedNames: untracked.size,
        },
        crawlerHits: {
          total: hitsInWindow.length,
          distinctVendors: new Set(hitsInWindow.map((h) => h.botVendor)).size,
          byType,
          // All-time, so "zero hits this window" can be told apart from "log
          // ingestion has never received anything" — a real zero versus an
          // unconfigured collector.
          everIngested: crawlerHits.length,
        },
        referringDomains: latestBacklinks
          ? {
              // `null` stays null: the provider returning no number is not the
              // provider returning zero domains.
              value: latestBacklinks.referringDomains ?? null,
              capturedAt: latestBacklinks.createdAt.toISOString(),
              status: latestBacklinks.status,
            }
          : null,
        coverage: { expected: expectedUnits, succeeded: succeededUnits, failed: failedUnits, pending: pendingUnits },
        score: scoreRow
          ? {
              id: scoreRow.id,
              total: scoreRow.total,
              band: scoreRow.band,
              rubricVersion: scoreRow.rubricVersion,
              status: scoreRow.status,
              at: scoreRow.createdAt.toISOString(),
            }
          : null,
      },
      pending,
      failed,
    };
  }

  /**
   * Build the freshness block.
   *
   * `periodEndsOn` is copied straight from the window. `latestSourceObservedAt`
   * is the newest timestamp any pinned source carries. They are never the same
   * field, and {@link EvidenceFreshness.statement} says the difference in
   * words so no surface has to decide which one "last updated" means.
   */
  buildFreshness(
    window: ResultsWindow,
    perSource: Partial<Record<EvidenceSourceType, string>>,
    observedDates: Date[],
  ): EvidenceFreshness {
    const sorted = observedDates
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    const earliest = sorted[0] ?? null;
    const latest = sorted[sorted.length - 1] ?? null;
    const periodEnd = new Date(window.endsOn);
    const stalenessDays = latest ? Math.max(0, daysBetween(latest, periodEnd)) : null;

    let statement: string;
    if (!latest) {
      statement = `No source recorded anything inside ${window.startsOn} - ${window.endsOn}. The window ends ${window.endsOn}; that is the period end, not a last-updated date.`;
    } else if (stalenessDays && stalenessDays > 0) {
      statement = `The newest evidence is from ${latest.toISOString()}, ${stalenessDays} day${stalenessDays === 1 ? '' : 's'} before the period end (${window.endsOn}). The period end is when the window closes, not when data was last observed.`;
    } else {
      statement = `The newest evidence is from ${latest.toISOString()}, inside the period ending ${window.endsOn}.`;
    }

    return {
      latestSourceObservedAt: latest ? latest.toISOString() : null,
      earliestSourceObservedAt: earliest ? earliest.toISOString() : null,
      periodEndsOn: window.endsOn,
      sourcesPredatePeriodEnd: stalenessDays !== null && stalenessDays > 0,
      stalenessDays,
      perSource,
      statement,
    };
  }

  /**
   * Persist a manifest for a subject.
   *
   * `subjectType: 'report'` requires a `subjectId`: a manifest that names no
   * subject cannot later be checked against the thing it is evidence for, and
   * the whole point is that a released report can be traced to its rows.
   */
  async create(
    projectId: string,
    dto: CreateManifestDto,
    window: ResultsWindow,
  ): Promise<EvidenceManifestView> {
    const subjectType = dto.subjectType ?? 'result-set';
    if (subjectType === 'report') {
      if (!dto.subjectId) {
        throw new BadRequestException('A manifest with subjectType "report" must name the report (or revision) it is evidence for');
      }
      const report = await this.prisma.report.findFirst({ where: { id: dto.subjectId, projectId }, select: { id: true } });
      if (!report) throw new NotFoundException(`Report ${dto.subjectId} not found for project ${projectId}`);
    }
    if (dto.cohortId) {
      const cohort = await this.prisma.measurementCohort.findFirst({ where: { id: dto.cohortId, projectId }, select: { id: true } });
      if (!cohort) throw new NotFoundException(`Measurement cohort ${dto.cohortId} not found for project ${projectId}`);
    }

    const collected = await this.collect(projectId, window, dto.scoreRunId);

    const row = await this.prisma.evidenceManifest.create({
      data: {
        projectId,
        subjectType,
        subjectId: dto.subjectId ?? null,
        periodId: dto.periodId ?? null,
        cohortId: dto.cohortId ?? null,
        sources: JSON.stringify(collected.bundle.sources),
        coverage: JSON.stringify(collected.bundle.coverage),
        sourceDates: JSON.stringify(collected.bundle.freshness.perSource),
        scoreRunId: collected.bundle.scoreRunId,
        rubricVersion: collected.bundle.rubricVersion,
        omissions: JSON.stringify([...collected.bundle.omissions, ...collected.bundle.truncations]),
      },
    });

    return this.toView(row, window);
  }

  /** One manifest, resolved inside its project — a foreign id 404s. */
  async get(projectId: string, id: string): Promise<EvidenceManifestView> {
    const row = await this.prisma.evidenceManifest.findFirst({ where: { id, projectId } });
    if (!row) throw new NotFoundException(`Evidence manifest ${id} not found for project ${projectId}`);
    return this.toView(row, await this.windowFor(row));
  }

  /** A project's manifests, newest first. */
  async list(
    projectId: string,
    filter: { subjectType?: string; subjectId?: string; periodId?: string; limit: number },
  ): Promise<EvidenceManifestView[]> {
    const rows = await this.prisma.evidenceManifest.findMany({
      where: {
        projectId,
        ...(filter.subjectType ? { subjectType: filter.subjectType } : {}),
        ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
        ...(filter.periodId ? { periodId: filter.periodId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
    });

    const windows = new Map<string, ResultsWindow | null>();
    const views: EvidenceManifestView[] = [];
    for (const row of rows) {
      if (!windows.has(row.id)) windows.set(row.id, await this.windowFor(row));
      views.push(this.toView(row, windows.get(row.id) ?? null));
    }
    return views;
  }

  /**
   * The manifest already pinned for a subject, if any. Used by a results read
   * to say "this window has a stored snapshot" rather than re-deriving one.
   */
  async findForSubject(
    projectId: string,
    subjectType: string,
    subjectId: string | null,
    periodId: string | null,
  ): Promise<EvidenceManifestView | null> {
    const row = await this.prisma.evidenceManifest.findFirst({
      where: {
        projectId,
        subjectType,
        ...(subjectId ? { subjectId } : {}),
        ...(periodId ? { periodId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    return this.toView(row, await this.windowFor(row));
  }

  // ── Privates ──────────────────────────────────────────────────────

  /**
   * The window a stored manifest describes, read from its `ReportPeriod`.
   * Null when the manifest was built from request bounds — in that case there
   * is no stored window, and saying so is better than reconstructing one.
   */
  private async windowFor(row: { periodId: string | null }): Promise<ResultsWindow | null> {
    if (!row.periodId) return null;
    const period = await this.prisma.reportPeriod.findUnique({ where: { id: row.periodId } });
    if (!period) return null;
    return {
      appliedBy: 'period',
      periodId: period.id,
      label: period.label,
      startsOn: period.startsOn.toISOString(),
      endsOn: period.endsOn.toISOString(),
      timezone: period.timezone,
      stored: true,
      days: daysBetween(period.startsOn, period.endsOn),
      reproducibilityNote: null,
    };
  }

  private toView(
    row: {
      id: string;
      projectId: string;
      subjectType: string;
      subjectId: string | null;
      periodId: string | null;
      cohortId: string | null;
      sources: string;
      coverage: string;
      sourceDates: string;
      scoreRunId: string | null;
      rubricVersion: string | null;
      omissions: string;
      createdAt: Date;
    },
    window: ResultsWindow | null,
  ): EvidenceManifestView {
    const sourceDates = parseRecord(row.sourceDates) as Partial<Record<EvidenceSourceType, string>>;
    const coverage = parseRecord(row.coverage) as Partial<Record<EvidenceSourceType, EvidenceCoverage>>;
    const omissionsRaw = parseJson<string[]>(row.omissions, []);
    const omissions = Array.isArray(omissionsRaw) ? omissionsRaw.filter((x): x is string => typeof x === 'string') : [];

    const dates = Object.values(sourceDates)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()));

    const freshness = this.buildFreshness(
      window ?? {
        appliedBy: 'request',
        periodId: null,
        label: null,
        startsOn: row.createdAt.toISOString(),
        endsOn: row.createdAt.toISOString(),
        timezone: 'UTC',
        stored: false,
        days: 0,
        reproducibilityNote: 'This manifest was built without a stored ReportPeriod, so it records no window.',
      },
      sourceDates,
      dates,
    );

    return {
      id: row.id,
      projectId: row.projectId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      periodId: row.periodId,
      cohortId: row.cohortId,
      createdAt: row.createdAt.toISOString(),
      manifestId: row.id,
      pinned: true,
      sources: parseJson<Partial<Record<EvidenceSourceType, string[]>>>(row.sources, {}),
      coverage,
      freshness,
      omissions: omissions.filter((entry) => entry.startsWith(ABSENCE_PREFIX)).map((entry) => entry.slice(ABSENCE_PREFIX.length)),
      truncations: omissions.filter((entry) => entry.startsWith(TRUNCATION_PREFIX)).map((entry) => entry.slice(TRUNCATION_PREFIX.length)),
      scoreRunId: row.scoreRunId,
      rubricVersion: row.rubricVersion,
      window,
    };
  }
}

/** Every observation timestamp, for the freshness range. */
function rowsAt(...groups: SourceRow[][]): Date[] {
  const dates: Date[] = [];
  for (const group of groups) {
    for (const row of group) {
      if (row.at) dates.push(row.at);
    }
  }
  return dates;
}

/** One sentence summarising a source's failures, capped so a bad run cannot flood the response. */
function describeFailures(rows: SourceRow[]): string {
  const reasons = Array.from(new Set(rows.map((row) => row.reason).filter((r): r is string => Boolean(r))));
  if (reasons.length === 0) return `${rows.length} row(s) failed without recording a reason.`;
  if (reasons.length === 1) return reasons[0];
  return `${reasons[0]} (+${reasons.length - 1} more distinct reason${reasons.length === 2 ? '' : 's'})`;
}

/**
 * `EvidenceManifest.omissions` is one JSON column holding two different facts:
 * what was *absent* and what was *truncated*. They are distinguished by a
 * stored prefix so both survive a round-trip through the column and can be
 * split back apart on read without adding a schema field.
 */
const ABSENCE_PREFIX = 'absent: ';
const TRUNCATION_PREFIX = 'truncated: ';
