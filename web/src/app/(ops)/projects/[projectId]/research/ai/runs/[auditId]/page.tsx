'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RateBarChart, type RateBarDatum } from '@/components/charts/RateBarChart';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { RunStatusStrip } from '@/components/patterns/RunStatusStrip';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, formatPercent, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import type { CoverageSummary, RunStatus } from '@/types';
import {
  AEO_MIN_RUN_COUNT,
  AEO_SURFACE_LABELS,
  getAeoAudit,
  judgeAeoStance,
  resumeAeoAudit,
  type AeoAuditDetail,
  type AeoCompetitorStanding,
  type AeoSurfaceComparison,
  type AeoSurfaceRun,
} from '@/services/research';

/**
 * AE03 — AI run detail.
 *
 * design_plan.md §4.3: *"Stage and surface results, failures/fallback provider,
 * verdict, resume, stance review"*, under the run/evidence-detail contract.
 *
 * §5.6 and §6.4 set the rules this screen exists to keep, and they are the
 * reason it is shaped the way it is:
 *
 *  1. **The headline is a rate over answers that came back, never over prompts
 *     sent.** Every counted figure is rendered with its denominator
 *     (`observations` / `prompts`), and the coverage panel states how many
 *     scheduled calls actually produced an answer. When a surface returns fewer
 *     answers than the n≥5 floor, that surface is flagged and no significance
 *     is claimed from its rates.
 *  2. **Counted and judged never merge.** Mention/citation/SOV come from the
 *     deterministic extraction; stance comes from an LLM reading the text. They
 *     are separate blocks with separate provenance badges, because a judgement
 *     is not a measurement (§6.4).
 *  3. **A fallback transport is named.** When a `cloro-*` engine failed and its
 *     `*-browser` equivalent answered instead, the row says so — the plan
 *     explicitly forbids reporting a browser-fallback answer as a Cloro
 *     measurement (§5.6 step 9).
 *  4. **A charted rate carries its own denominator, and a thin engine is not
 *     drawn as if it were comparable.** The two rate charts draw
 *     `counted.bySurface` exactly as the server returned it, label every bar
 *     with the answers it was counted over, and de-emphasize the engines whose
 *     own surface runs fell below the n≥5 floor. Each chart ships a table of
 *     the same values (§3.4), and neither divides a numerator by a denominator
 *     to produce a rate the server did not compute.
 */

export default function AeoRunPage() {
  const { projectId, auditId } = useParams<{ projectId: string; auditId: string }>();

  const [audit, setAudit] = useState<AeoAuditDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [stanceOpen, setStanceOpen] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setAudit(await getAeoAudit(projectId, auditId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, auditId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * Coverage of the run, in the only terms the backend supports: how many
   * answers each scheduled surface run was supposed to produce, and how many it
   * did.
   */
  const coverage = useMemo((): CoverageSummary | null => {
    if (!audit) return null;
    const perSurfaceRun = audit.promptCount * audit.runCount;
    const expected = audit.surfaceRuns.length * perSurfaceRun;
    const successful = audit.surfaceRuns.reduce((total, run) => total + run.observations, 0);
    return {
      expectedCount: expected,
      successfulCount: successful,
      failed: audit.surfaceRuns
        .filter((run) => run.status === 'failed' || run.status === 'skipped')
        .map((run) => ({
          name: surfaceRunLabel(run),
          reason: [run.failureKind, run.error].filter(Boolean).join(' — ') ||
            'The surface reported no reason for producing nothing.',
        })),
      deferred: audit.surfaceRuns
        .filter((run) => run.status === 'pending' || run.status === 'running')
        .map((run) => ({
          name: surfaceRunLabel(run),
          reason:
            run.status === 'running'
              ? 'Still being measured; answers counted so far.'
              : 'Not started yet — the audit has not reached this surface.',
        })),
    };
  }, [audit]);

  /** Surfaces whose answer count is below the n≥5 floor per prompt. */
  const thinSurfaces = useMemo(() => {
    if (!audit) return [];
    const floor = audit.promptCount * AEO_MIN_RUN_COUNT;
    if (floor === 0) return [];
    return audit.surfaceRuns.filter(
      (run) => run.status === 'completed' && run.observations < floor,
    );
  }, [audit]);

  /**
   * Engines whose rate is **not** a comparable measurement, keyed by surface,
   * with the reason in the screen's own words.
   *
   * The floor is per prompt **per surface run**, and a run is one engine × one
   * market. `counted.bySurface` aggregates an engine across its markets, so
   * testing the aggregate against the floor would let a thin engine pass on the
   * strength of a sibling market. The test therefore goes against the surface
   * runs themselves — the same rows `thinSurfaces` above already names.
   *
   * A run that did not complete is excluded for a second, independent reason:
   * a failed or skipped engine can still hold a handful of stored answers, and
   * a rate computed from a run that broke part-way is not a measurement of that
   * engine. Either way the row is drawn receded and the reason is stated beside
   * its rate, never left to the color.
   */
  const notComparableSurfaces = useMemo(() => {
    const flagged = new Map<string, string>();
    if (!audit) return flagged;
    const floor = audit.promptCount * AEO_MIN_RUN_COUNT;
    for (const run of audit.surfaceRuns) {
      if (run.status !== 'completed') {
        flagged.set(
          run.surface,
          `Not compared — its surface run for ${run.market ?? 'this market'} is ${run.status}, so this rate is not a complete measurement of the engine.`,
        );
        continue;
      }
      if (floor > 0 && run.observations < floor) {
        flagged.set(
          run.surface,
          `Not compared — a surface run returned fewer than the floor of ${formatNumber(floor)} answers (n≥${formatNumber(AEO_MIN_RUN_COUNT)} per prompt).`,
        );
      }
    }
    return flagged;
  }, [audit]);

  /**
   * The per-engine rows the two rate charts draw.
   *
   * Every number is read from `counted.bySurface`, which the server computed:
   * the rate arrives with the denominator it was counted over, and this page
   * never divides one of those by the other to make a percentage of its own
   * (§6.3/§6.4). Engines with no answers are left out — `0/0` has no rate — and
   * the chart names them in its notes rather than plotting them at zero.
   */
  const surfaceRateRows = useMemo<RateBarDatum[]>(() => {
    const bySurface = audit?.verdict?.counted.bySurface ?? [];
    return bySurface.map((row) => {
      const reason = notComparableSurfaces.get(row.surface);
      return {
        id: row.surface,
        label: row.label,
        rate: row.mentionRate,
        denominator: row.observations,
        comparable: reason === undefined,
        notComparableReason: reason,
      };
    });
  }, [audit, notComparableSurfaces]);

  const surfaceCitationRows = useMemo<RateBarDatum[]>(() => {
    const bySurface = audit?.verdict?.counted.bySurface ?? [];
    return bySurface.map((row) => {
      const reason = notComparableSurfaces.get(row.surface);
      return {
        id: row.surface,
        label: row.label,
        rate: row.citationRate,
        denominator: row.observations,
        comparable: reason === undefined,
        notComparableReason: reason,
      };
    });
  }, [audit, notComparableSurfaces]);

  const surfaceColumns: ReadonlyArray<ColumnDef<AeoSurfaceRun>> = [
    {
      key: 'surface',
      header: 'Engine · market',
      accessor: (row) => surfaceRunLabel(row),
      sortable: true,
      width: 220,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => <StatusPill label={surfaceStatusLabel(row.status)} tone={surfaceStatusTone(row.status)} />,
    },
    {
      key: 'answers',
      header: 'Answers returned',
      accessor: (row) => row.observations,
      sortable: true,
      align: 'right',
      width: 150,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.observations)}
          <span className="text-muted-foreground">
            {' '}
            of {formatNumber(audit ? audit.promptCount * audit.runCount : 0)}
          </span>
        </span>
      ),
    },
    {
      key: 'transport',
      header: 'Answered via',
      accessor: (row) => row.attemptedVia ?? row.surface,
      width: 200,
      render: (row) =>
        row.attemptedVia && row.attemptedVia !== row.surface ? (
          // §5.6 step 9: an API label, a browser label and a Cloro label are
          // different observations. Never silently reported as the requested one.
          <span className="text-warning-foreground">
            Fallback: {AEO_SURFACE_LABELS[row.attemptedVia] ?? row.attemptedVia}
            <span className="sr-only">
              {' '}
              — the requested engine did not answer, so this did not come from it.
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">The requested engine</span>
        ),
    },
    {
      key: 'failure',
      header: 'Failure',
      accessor: (row) => row.failureKind ?? row.error ?? '',
      emptyLabel: 'None recorded',
      render: (row) =>
        row.failureKind || row.error ? (
          <span className="block max-w-[22rem] text-table text-danger-foreground">
            {[row.failureKind, row.error].filter(Boolean).join(' — ')}
          </span>
        ) : null,
    },
    {
      key: 'observations',
      header: '',
      width: 130,
      alwaysVisible: true,
      render: (row) =>
        row.runId ? (
          <Link
            href={`/projects/${projectId}/research/ai/observations/${row.runId}`}
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Read answers
          </Link>
        ) : (
          <span className="text-meta text-muted-foreground">No run stored</span>
        ),
    },
  ];

  const surfaceComparisonColumns: ReadonlyArray<ColumnDef<AeoSurfaceComparison>> = [
    {
      key: 'label',
      header: 'Engine',
      accessor: (row) => row.label,
      sortable: true,
      width: 180,
    },
    {
      key: 'observations',
      header: 'Answers',
      accessor: (row) => row.observations,
      sortable: true,
      align: 'right',
      width: 110,
      render: (row) => (
        <span className="tabular-nums">{formatNumber(row.observations)}</span>
      ),
    },
    {
      key: 'mentionRate',
      header: 'Named (all prompts)',
      accessor: (row) => row.mentionRate,
      sortable: true,
      align: 'right',
      width: 160,
      render: (row) => <RateWithDenominator rate={row.mentionRate} slice={row} />,
    },
    {
      key: 'unbrandedMentionRate',
      header: 'Named (unbranded prompts)',
      accessor: (row) => row.unbrandedMentionRate,
      sortable: true,
      align: 'right',
      width: 200,
      render: (row) => (
        <span className="tabular-nums">
          {formatPercent(row.unbrandedMentionRate * 100)}
          <span className="text-meta text-muted-foreground"> of answers to unbranded prompts</span>
        </span>
      ),
    },
    {
      key: 'citationRate',
      header: 'Cited',
      accessor: (row) => row.citationRate,
      sortable: true,
      align: 'right',
      width: 150,
      render: (row) => (
        <span className="tabular-nums">
          {formatPercent(row.citationRate * 100)}
          <span className="text-meta text-muted-foreground"> of {formatNumber(row.observations)}</span>
        </span>
      ),
    },
    {
      key: 'rivalsAheadCount',
      header: 'Rivals named, client absent',
      accessor: (row) => row.rivalsAheadCount,
      sortable: true,
      align: 'right',
      width: 190,
      render: (row) => <span className="tabular-nums">{formatNumber(row.rivalsAheadCount)}</span>,
    },
  ];

  const competitorColumns: ReadonlyArray<ColumnDef<AeoCompetitorStanding>> = [
    {
      key: 'name',
      header: 'Brand',
      accessor: (row) => row.name,
      sortable: true,
    },
    {
      key: 'observations',
      header: 'Answers naming them',
      accessor: (row) => row.observations,
      sortable: true,
      align: 'right',
      width: 180,
      render: (row) => <span className="tabular-nums">{formatNumber(row.observations)}</span>,
    },
    {
      key: 'mentionRate',
      header: 'Share of answers',
      accessor: (row) => row.mentionRate,
      sortable: true,
      align: 'right',
      width: 160,
      render: (row) => (
        <span className="tabular-nums">
          {formatPercent(row.mentionRate * 100)}
          <span className="text-meta text-muted-foreground"> counted</span>
        </span>
      ),
    },
    {
      key: 'aheadBehind',
      header: 'Placed above / below the client',
      accessor: (row) => row.clientBehindCount,
      sortable: true,
      align: 'right',
      width: 220,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.clientBehindCount)} above · {formatNumber(row.clientAheadCount)} below
          <span className="text-meta text-muted-foreground"> judged</span>
        </span>
      ),
    },
    {
      key: 'wonWhileClientAbsent',
      header: 'Named while the client was absent',
      accessor: (row) => row.wonWhileClientAbsent,
      sortable: true,
      align: 'right',
      width: 220,
      render: (row) => <span className="tabular-nums">{formatNumber(row.wonWhileClientAbsent)}</span>,
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI visibility run" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!audit) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const verdict = audit.verdict;
  const erroredSurfaces = audit.surfaceRuns.filter((run) => run.status === 'failed');
  const fallbacks = audit.surfaceRuns.filter(
    (run) => run.attemptedVia !== null && run.attemptedVia !== run.surface,
  );
  const countable = coverage ? coverage.successfulCount : 0;
  const thin = Boolean(coverage && coverage.expectedCount > 0 && countable < coverage.expectedCount);

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          projectName: 'This project',
          market: audit.markets.length > 0 ? audit.markets.join(', ') : undefined,
          mode: 'live',
          runLabel: `Run ${audit.id}`,
        }}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}/research/ai`}>Back to AI visibility</Link>
          </Button>
        }
      />

      <PageHeader
        title="AI visibility run"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              {audit.surfaces.length} engine{audit.surfaces.length === 1 ? '' : 's'} ·{' '}
              {audit.markets.length > 0 ? audit.markets.join(', ') : 'market derived from context'}
            </span>
            <span>
              Tier <span className="font-mono">{audit.tier}</span> · {formatNumber(audit.promptCount)} prompts
              · n={formatNumber(audit.runCount)}
            </span>
            {audit.startedAt ? (
              <span>
                Started <Timestamp value={audit.startedAt} />
              </span>
            ) : null}
          </span>
        }
        status={<StatusPill label={auditStatusLabel(audit.status)} tone={auditStatusTone(audit.status)} />}
        secondaryActions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => setStanceOpen(true)}>
              Run stance review
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResumeOpen(true)}
              disabled={audit.status === 'completed'}
            >
              Resume run
            </Button>
          </>
        }
      />

      {actionError ? <ErrorState error={actionError} layout="inline" /> : null}
      {actionResult ? (
        <p role="status" className="rounded-md border border-info/30 bg-info-subtle px-3 py-2 text-table text-info-foreground">
          {actionResult}
        </p>
      ) : null}

      {erroredSurfaces.length > 0 || fallbacks.length > 0 ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Not every engine produced a clean measurement</AlertTitle>
          <AlertDescription>
            {erroredSurfaces.length > 0
              ? `${erroredSurfaces.length} engine(s) failed and are named below with their reason. `
              : ''}
            {fallbacks.length > 0
              ? `${fallbacks.length} engine(s) were answered by a fallback transport instead of the one requested. `
              : ''}
            The other engines&rsquo; results are unaffected — one dead surface does not void the run — but
            the coverage panel states exactly how much of the run is missing.
          </AlertDescription>
        </Alert>
      ) : null}

      <RunStatusStrip
        run={{
          id: audit.id,
          status: runStatus(audit.status, erroredSurfaces.length > 0),
          startedAt: audit.startedAt ?? audit.createdAt ?? new Date().toISOString(),
          completedAt: audit.finishedAt ?? undefined,
          stage: audit.stage ? { name: audit.stage } : undefined,
        }}
        detail={
          <div className="space-y-1">
            <p>
              Last completed stage: <span className="font-mono">{audit.stage ?? 'none recorded'}</span>.
              Uses {formatNumber(audit.observations)} stored answers and {formatNumber(audit.stanceJudged)}{' '}
              judged observations.
            </p>
            {audit.error ? <p className="text-danger-foreground">{audit.error}</p> : null}
          </div>
        }
      >
        <div className="space-y-6">
          {coverage ? (
            <CoveragePanel
              summary={coverage}
              title="Answer coverage for this run"
              contextNote={
                <span>
                  Expected counts are scheduled calls: {formatNumber(audit.promptCount)} prompts × n=
                  {formatNumber(audit.runCount)} repeats × {formatNumber(audit.surfaceRuns.length)} engine and
                  market combinations. Rates anywhere on this page are over the{' '}
                  {formatNumber(coverage.successfulCount)} answers that actually came back.
                </span>
              }
            />
          ) : null}

          {thin || thinSurfaces.length > 0 ? (
            <Alert>
              <AlertTriangle aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>Thin coverage — no significance is claimed from these rates</AlertTitle>
              <AlertDescription>
                {thin
                  ? `This run returned ${formatNumber(countable)} answers against ${formatNumber(
                      coverage?.expectedCount ?? 0,
                    )} scheduled calls. `
                  : ''}
                {thinSurfaces.length > 0
                  ? `${thinSurfaces.map(surfaceRunLabel).join(', ')} returned fewer than ${formatNumber(
                      AEO_MIN_RUN_COUNT,
                    )} answers per prompt, which is the floor below which Cailyx does not report a rate. `
                  : ''}
                The figures below describe the answers that were received. They are not a description of the
                engine&rsquo;s general behaviour, and no comparison or trend should be drawn from them.
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Stage and surface results</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {audit.surfaceRuns.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="per-engine results"
                  prerequisite="the audit has to reach its measurement stage before any engine has an answer count."
                />
              ) : (
                <DataTable
                  caption="Engines measured by this run"
                  columns={surfaceColumns}
                  rows={audit.surfaceRuns}
                  getRowId={(row) => `${row.surface}-${row.market ?? 'any'}`}
                  minTableWidth="66rem"
                  filters={[
                    {
                      id: 'status',
                      label: 'Status',
                      options: [
                        { value: 'completed', label: 'Completed' },
                        { value: 'failed', label: 'Failed' },
                        { value: 'skipped', label: 'Skipped' },
                        { value: 'pending', label: 'Pending' },
                        { value: 'running', label: 'Running' },
                      ],
                      getValue: (row) => row.status,
                    },
                  ]}
                  emptyState={<EmptyState variant="no-results" />}
                />
              )}
            </CardContent>
          </Card>

          {!verdict ? (
            <Card>
              <CardContent className="pt-6">
                <EmptyState
                  variant="not-measured"
                  subject="the run verdict"
                  prerequisite={`the audit must finish its measurement and verdict stages — it is currently at "${audit.status}".`}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              <section aria-labelledby="counted-heading" className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="counted-heading" className="text-subsection font-semibold text-foreground">
                    Counted visibility
                  </h2>
                  <ProvenanceBadge kind="measured" />
                </div>

                {verdict.headlines.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-table text-foreground">
                    {verdict.headlines.map((headline) => (
                      <li key={headline}>{headline}</li>
                    ))}
                  </ul>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-2">
                  <RateCard
                    title="Named in an answer"
                    slice={verdict.counted.overall}
                    tone="info"
                  />
                  <RateCard
                    title="Named in an answer — unbranded prompts only"
                    slice={verdict.counted.unbranded}
                    tone="info"
                    note="Branded prompts name the client in the question, so this is the honest visibility figure."
                  />
                  <RateCard title="Branded prompts" slice={verdict.counted.branded} tone="neutral" />
                </div>

                {/*
                  Two counted rates, drawn as two charts rather than one chart
                  with two series. §3.1's token table has exactly one
                  categorical hue (every other saturated token is a reserved
                  status color), so a second series would have to be invented —
                  and a colour that is not in the palette is how a chart becomes
                  the one place in the product that ignores the theme.

                  Each chart carries its own table directly beneath it (§3.4),
                  so no rate on this page is readable only by hovering a bar.
                */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-subsection">Rate by engine</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-2">
                    <div className="grid gap-6 xl:grid-cols-2">
                      <RateBarChart
                        measureLabel="Named in an answer"
                        rows={surfaceRateRows}
                        samplingFloor={audit.promptCount * AEO_MIN_RUN_COUNT}
                        description={
                          <>
                            The share of answers that came back naming the client, one bar per engine.
                            Every bar is labelled with the number of answers its rate was counted over:
                            the denominator is the answers that returned, never the prompts that were
                            sent.
                          </>
                        }
                        emptyState={
                          <EmptyState
                            variant="not-measured"
                            subject="a per-engine naming rate"
                            prerequisite="an engine has to return at least one answer before it has a rate."
                          />
                        }
                      />
                      <RateBarChart
                        measureLabel="Cited"
                        rows={surfaceCitationRows}
                        samplingFloor={audit.promptCount * AEO_MIN_RUN_COUNT}
                        description={
                          <>
                            The share of the same answers citing the client&rsquo;s domain. Held apart from
                            the naming rate on purpose: a brand named in an answer and a domain cited as a
                            source are two different measurements, and merging them would state one figure
                            the source never measured.
                          </>
                        }
                        emptyState={
                          <EmptyState
                            variant="not-measured"
                            subject="a per-engine citation rate"
                            prerequisite="an engine has to return at least one answer before it has a rate."
                          />
                        }
                      />
                    </div>
                    <p className="mt-4 text-meta text-muted-foreground">
                      The engine-by-engine table below carries these same rates beside the answers each
                      was counted over, the unbranded-prompt breakdown and the rival standings.
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-subsection">Engine by engine</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-2">
                    {verdict.counted.bySurface.length === 0 ? (
                      <EmptyState
                        variant="not-measured"
                        subject="a per-engine comparison"
                        prerequisite="more than one engine must have returned answers."
                      />
                    ) : (
                      <DataTable
                        caption="Counted metrics by engine"
                        columns={surfaceComparisonColumns}
                        rows={verdict.counted.bySurface}
                        getRowId={(row) => row.surface}
                        minTableWidth="68rem"
                        emptyState={<EmptyState variant="no-results" />}
                      />
                    )}
                  </CardContent>
                </Card>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-subsection">Share of voice</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-2">
                      {verdict.counted.shareOfVoice.length === 0 ? (
                        <p className="text-table text-muted-foreground">
                          No brand — the client&rsquo;s or a competitor&rsquo;s — was named in any answer, so
                          there is no share to divide.
                        </p>
                      ) : (
                        <ul className="divide-y divide-border">
                          {verdict.counted.shareOfVoice.map((row) => (
                            <li key={row.name} className="flex items-center justify-between gap-4 py-2">
                              <span className="text-table">{row.name}</span>
                              <span className="text-table tabular-nums">
                                {formatPercent(row.share * 100)}
                                <span className="text-meta text-muted-foreground"> of answers</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-subsection">Competitors named</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-2">
                      {verdict.counted.competitors.length === 0 ? (
                        <p className="text-table text-muted-foreground">
                          No tracked competitor was named in any answer of this run.
                        </p>
                      ) : (
                        <DataTable
                          caption="Competitor standings across this run"
                          columns={competitorColumns}
                          rows={verdict.counted.competitors}
                          getRowId={(row) => row.name}
                          minTableWidth="46rem"
                          emptyState={<EmptyState variant="no-results" />}
                        />
                      )}
                    </CardContent>
                  </Card>
                </div>
              </section>

              <section aria-labelledby="judged-heading" className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="judged-heading" className="text-subsection font-semibold text-foreground">
                    Judged stance
                  </h2>
                  <ProvenanceBadge kind="model-interpretation" />
                </div>

                <Card>
                  <CardContent className="space-y-3 pt-6">
                    {!verdict.judged.available ? (
                      <>
                        <p className="text-table text-foreground">
                          No stance was judged for this run
                          {verdict.judged.unavailableReason ? `: ${verdict.judged.unavailableReason}` : '.'}
                        </p>
                        <p className="text-table text-muted-foreground">
                          Stance is an opinion about how the answers positioned the client, produced by
                          reading the answer text. It is not a measurement and it is never merged into the
                          counted rates above — the counted figures stand on their own without it.
                        </p>
                        <Button variant="outline" size="sm" onClick={() => setStanceOpen(true)}>
                          Run the stance review
                        </Button>
                      </>
                    ) : (
                      <>
                        <p className="text-table text-muted-foreground">
                          {formatNumber(verdict.judged.observationsJudged)} answers were read by{' '}
                          <span className="font-mono">{verdict.judged.judgeModel ?? 'an unrecorded model'}</span>{' '}
                          and placed into one of five stances. These are opinions with a supporting quote,
                          never rates.
                        </p>
                        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {Object.entries(verdict.judged.stanceCounts).map(([stance, count]) => (
                            <li key={stance} className="flex items-center justify-between gap-4 text-table">
                              <span>{stanceLabel(stance)}</span>
                              <span className="tabular-nums">{formatNumber(count)}</span>
                            </li>
                          ))}
                        </ul>

                        {verdict.judged.losingPrompts.length > 0 ? (
                          <div>
                            <h3 className="text-meta font-semibold text-foreground">
                              Prompts where a competitor was placed ahead
                            </h3>
                            <ul className="mt-1 divide-y divide-border">
                              {verdict.judged.losingPrompts.slice(0, 10).map((row) => (
                                <li key={row.prompt} className="space-y-0.5 py-2">
                                  <p className="text-table text-foreground">{row.prompt}</p>
                                  <p className="text-meta text-muted-foreground">
                                    Ahead: {row.losesTo.join(', ') || 'not stated'}
                                  </p>
                                  {row.evidenceQuote ? (
                                    <blockquote className="evidence border-l-2 border-border pl-2 text-muted-foreground">
                                      {row.evidenceQuote}
                                    </blockquote>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </>
                    )}
                  </CardContent>
                </Card>
              </section>

              <p className="text-meta text-muted-foreground">
                Verdict generated <Timestamp value={verdict.generatedAt} /> from{' '}
                {formatNumber(verdict.counted.overall.observations)} answers. Counted figures were produced by
                deterministic extraction; the judged block was produced by a model reading the same answers.
              </p>
            </>
          )}
        </div>
      </RunStatusStrip>

      <ConfirmDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title="Resume this audit"
        confirmLabel="Resume the run"
        targetLabel="Audit"
        target={audit.id}
        effect={
          <p>
            The audit continues from its last completed stage
            {audit.stage ? ` (${audit.stage})` : ''}. Already-stored context and matrix are reused rather
            than re-scraped, but the remaining measurement calls are made and are metered like the original
            run. This request may stay open until the stage finishes — leaving the page does not stop it.
          </p>
        }
        scope={<p>This affects the audit {audit.id} only.</p>}
        onConfirm={async () => {
          setActionResult(null);
          setActionError(null);
          try {
            await resumeAeoAudit(projectId, audit.id);
            await load();
            setActionResult('The run advanced. Its stored history above reflects the new state.');
          } catch (caught) {
            setActionError(toApiError(caught));
          }
        }}
      >
        <p className="text-meta text-muted-foreground">
          Resuming is not idempotent in cost: the stages already completed are not repeated, but the ones
          that remain are paid for again if they run again.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={stanceOpen}
        onOpenChange={setStanceOpen}
        title="Run the stance review"
        confirmLabel="Judge stance"
        targetLabel="Audit"
        target={audit.id}
        effect={
          <p>
            Every stored answer is read by a language model and placed into a stance, with a supporting
            quote. Already-judged answers are skipped, so running it twice does not double the cost. The
            result is stored apart from the counted rates and is never merged into them.
          </p>
        }
        scope={<p>This reads the answers already stored for audit {audit.id}.</p>}
        onConfirm={async () => {
          setActionResult(null);
          setActionError(null);
          try {
            const result = await judgeAeoStance(projectId, audit.id);
            await load();
            setActionResult(
              `Judged ${formatNumber(result.judged)} answers, skipped ${formatNumber(result.skipped)} already judged, ${formatNumber(result.failed)} failed.`,
            );
          } catch (caught) {
            setActionError(toApiError(caught));
          }
        }}
      >
        <p className="text-meta text-muted-foreground">
          Judging spends model tokens. It does not re-measure anything, and it cannot change the counted
          rates above.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * Two counted rates with the denominator they were computed over.
 *
 * The denominator is the point: a mention rate over 4 returned answers and one
 * over 500 look identical as a percentage, and only one of them means anything.
 */
function RateCard({
  title,
  slice,
  tone,
  note,
}: {
  title: string;
  slice: { prompts: number; observations: number; mentionRate: number; citationRate: number };
  tone: 'info' | 'neutral';
  note?: string;
}) {
  const empty = slice.observations === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-2">
        {empty ? (
          <p className="text-table text-unmeasured-foreground">{notMeasuredLabel()}</p>
        ) : (
          <>
            <p className="text-kpi font-semibold tabular-nums text-foreground">
              {formatPercent(slice.mentionRate * 100)}
            </p>
            <p className="text-table text-muted-foreground">
              Named in {formatNumber(slice.observations)} answers to {formatNumber(slice.prompts)} prompts —
              the denominator is the answers that came back, not the prompts sent.
            </p>
            <p className="text-table text-muted-foreground">
              The client&rsquo;s domain was cited in {formatPercent(slice.citationRate * 100)} of the same{' '}
              {formatNumber(slice.observations)} answers.
            </p>
          </>
        )}
        <StatusPill label={tone === 'info' ? 'Counted' : 'Counted, no target set'} tone={tone} />
        {note ? <p className="text-meta text-muted-foreground">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

/** A rate in a table cell, with its own denominator beside it. */
function RateWithDenominator({
  rate,
  slice,
}: {
  rate: number;
  slice: { observations: number };
}) {
  if (slice.observations === 0) {
    return <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>;
  }
  return (
    <span className="tabular-nums">
      {formatPercent(rate * 100)}
      <span className="text-meta text-muted-foreground"> of {formatNumber(slice.observations)}</span>
    </span>
  );
}

function surfaceRunLabel(run: { surface: string; market: string | null }): string {
  const label = AEO_SURFACE_LABELS[run.surface] ?? run.surface;
  return run.market ? `${label} · ${run.market}` : label;
}

function surfaceStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    case 'running':
      return 'Running';
    case 'pending':
      return 'Pending';
    default:
      return status;
  }
}

function surfaceStatusTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'skipped':
      return 'warning';
    case 'running':
      return 'info';
    default:
      return 'unmeasured';
  }
}

function auditStatusLabel(status: string): string {
  return status.length > 0 ? status.charAt(0).toUpperCase() + status.slice(1) : status;
}

function auditStatusTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'pending':
      return 'unmeasured';
    default:
      return 'info';
  }
}

/**
 * The audit's status in `RunStatus` vocabulary. A completed audit with a failed
 * engine is **partial**, not completed — §3.5 forbids labelling a run with a
 * dead surface healthy.
 */
function runStatus(status: string, hasFailedSurface: boolean): RunStatus {
  if (status === 'failed') return 'failed';
  if (status === 'completed') return hasFailedSurface ? 'partial' : 'completed';
  if (status === 'pending') return 'queued';
  return 'running';
}

/** The five stances, in words. */
function stanceLabel(stance: string): string {
  switch (stance) {
    case 'recommended-primary':
      return 'Led the answer';
    case 'recommended-alternative':
      return 'One option among others';
    case 'mentioned-neutral':
      return 'Named, no endorsement';
    case 'mentioned-negative':
      return 'Named with a caveat';
    case 'absent':
      return 'Not named';
    default:
      return stance;
  }
}
