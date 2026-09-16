'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChangeComparison } from '@/components/patterns/ChangeComparison';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, formatPercent } from '@/lib/format';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  coverageSummaryFromEvidence,
  EVIDENCE_SOURCE_LABEL,
  getPortalResults,
  type PortalComparability,
  type PortalEvidenceSourceType,
  type PortalMetric,
  type PortalResultsView,
} from '@/services/portal-results';

/**
 * CP07 — Results.
 *
 * design_plan.md §4.5: *"Approved trend cards by engine/market, organic
 * results, source/coverage details."*
 *
 * Four rules from §6.3/§6.4 and the results contract are enforced here, three
 * of them structurally by the shapes this page is given:
 *
 *  1. **An unmeasured metric has no `value` at all** — `Metric.value` exists
 *     only on the `measured` branch of the union. Every tile therefore passes
 *     `value={metric.state === 'measured' ? metric.value : null}`, and `0` is
 *     not reachable for a window that was not measured.
 *  2. **Coverage travels with every result.** Each tile renders the run's
 *     coverage through `MetricTile`'s `coverage`, and the panel above names
 *     every failed and deferred source with its reason. A tile cannot imply a
 *     completeness the run did not have.
 *  3. **A methodology break withholds the comparison.** On `methodology-break`
 *     the response carries no `deltas` property at all, so no before/after pair
 *     exists to subtract — this page renders the break, the checks that
 *     produced it, and the sentence saying the delta was withheld. It does not
 *     compute one, and it draws no direction arrow.
 *  4. **Movement is not automatically good.** Every tile and every comparison
 *     is `direction="neutral"`: the results contract reports what moved, and
 *     §6.4 forbids inventing significance. Nothing here is tinted success or
 *     danger on the strength of its sign.
 *
 * "By engine / market" is a *filter over what each metric actually declares*
 * (`metric.scope.engines` / `.markets`), never a per-engine number: the backend
 * computes one value per metric over a cohort, and splitting it here would
 * fabricate data. A metric whose scope is not pinned says so.
 */
const FILTER_DEFAULTS = {
  engine: FILTER_ALL,
  market: FILTER_ALL,
  trend: FILTER_ALL,
};

const TREND_OPTIONS = [
  { value: 'measured', label: 'Measured only' },
  { value: 'not-measured', label: 'Not measured only' },
];

export default function ClientResultsPage() {
  // `useSearchParams` (through `useUrlState`) forces a client-side bailout
  // during prerendering, so the URL-reading part sits behind its own boundary.
  return (
    <Suspense fallback={<ResultsSkeleton />}>
      <ResultsScreen />
    </Suspense>
  );
}

function ResultsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-9 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-32 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function ResultsScreen() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [results, setResults] = useState<PortalResultsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        setError(null);
        const [projects, view] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalResults(projectId, {}, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setResults(view);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const coverage = useMemo(
    () => (results ? coverageSummaryFromEvidence(results.evidence) : null),
    [results],
  );

  const engineOptions = useMemo(() => {
    const engines = new Set<string>();
    results?.metrics.forEach((metric) => metric.scope.engines.forEach((engine) => engines.add(engine)));
    return [...engines].sort().map((engine) => ({ value: engine, label: engine }));
  }, [results]);

  const marketOptions = useMemo(() => {
    const markets = new Set<string>();
    results?.metrics.forEach((metric) => metric.scope.markets.forEach((market) => markets.add(market)));
    return [...markets].sort().map((market) => ({ value: market, label: market }));
  }, [results]);

  const visibleMetrics = useMemo(() => {
    if (!results) return [];
    return results.metrics.filter((metric) => {
      if (filters.engine !== FILTER_ALL) {
        // A metric whose scope is not pinned is not excluded by a scope filter —
        // hiding it would look like it was measured for that engine.
        if (metric.scope.engines.length > 0 && !metric.scope.engines.includes(filters.engine)) {
          return false;
        }
      }
      if (filters.market !== FILTER_ALL) {
        if (metric.scope.markets.length > 0 && !metric.scope.markets.includes(filters.market)) {
          return false;
        }
      }
      if (filters.trend === 'measured' && metric.state !== 'measured') return false;
      if (filters.trend === 'not-measured' && metric.state !== 'not-measured') return false;
      return true;
    });
  }, [results, filters]);

  const isFiltered =
    filters.engine !== FILTER_DEFAULTS.engine ||
    filters.market !== FILTER_DEFAULTS.market ||
    filters.trend !== FILTER_DEFAULTS.trend;

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Results" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!results || !project) {
    return <ResultsSkeleton />;
  }

  const comparability = results.comparability;

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: project.name,
          domain: project.domain,
          mode: 'live',
          runLabel: results.window.label ?? `${results.window.days}-day window`,
        }}
      />

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Results' },
        ]}
        title="Results"
        context={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <Timestamp value={results.window.startsOn} dateOnly /> –{' '}
              <Timestamp value={results.window.endsOn} dateOnly /> ({results.window.timezone})
            </span>
            <span className="text-muted-foreground">Read {formatIso(results.generatedAt)}</span>
          </span>
        }
        status={
          results.window.stored ? null : (
            <span className="text-meta text-warning-foreground">
              This window is not stored, so the same link returns a different window later.
            </span>
          )
        }
      />

      {/* ── What this read covers ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">What this read covers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <Fact label="Window">
              {results.window.label ? `${results.window.label} · ` : ''}
              {results.window.days} days
              <span className="mt-0.5 block text-meta text-muted-foreground">
                {results.window.stored
                  ? `Stored window (${results.window.appliedBy}) — the same link reproduces it.`
                  : (results.window.reproducibilityNote ??
                    'Resolved from the request, so it moves with the calendar.')}
              </span>
            </Fact>
            <Fact label="Engines">
              {results.cohort && results.cohort.engines.length > 0 ? (
                results.cohort.engines.join(', ')
              ) : (
                <span className="text-unmeasured-foreground">
                  Not pinned — comparisons are reported as a methodology break until a cohort is created.
                </span>
              )}
            </Fact>
            <Fact label="Markets">
              {results.cohort && results.cohort.markets.length > 0 ? (
                results.cohort.markets.join(', ')
              ) : (
                <span className="text-unmeasured-foreground">Not pinned</span>
              )}
            </Fact>
          </dl>

          {/* Freshness is stated as two different facts — §6.3 forbids printing
              the newest source date as "the period end". */}
          <p className="text-table text-muted-foreground">{results.evidence.freshness.statement}</p>
          <p className="text-meta text-muted-foreground">
            Newest data from the sources:{' '}
            {results.evidence.freshness.latestSourceObservedAt ? (
              <Timestamp value={results.evidence.freshness.latestSourceObservedAt} dateOnly />
            ) : (
              'none observed'
            )}{' '}
            · window ends{' '}
            <Timestamp value={results.evidence.freshness.periodEndsOn} dateOnly />
            {results.evidence.freshness.stalenessDays !== null
              ? ` · ${results.evidence.freshness.stalenessDays} day(s) between them`
              : ''}
            .
          </p>
          <p className="text-meta text-muted-foreground">
            {results.evidence.pinned
              ? `This read is reproducible: it is pinned to stored source rows (manifest ${results.evidence.manifestId}).`
              : 'This read is not pinned to a stored manifest, so it is a live read rather than a reproducible snapshot.'}
          </p>
        </CardContent>
      </Card>

      {/* ── Coverage ───────────────────────────────────────────────────── */}
      <section aria-labelledby="coverage-heading" className="space-y-3">
        <h2 id="coverage-heading" className="text-subsection font-semibold tracking-tight">
          Coverage
        </h2>
        {coverage === null ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="evidence coverage"
                prerequisite="No source reported a coverage count for this window."
              />
            </CardContent>
          </Card>
        ) : (
          <CoveragePanel
            summary={coverage}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={`/client/projects/${projectId}/connections`}>Check connections</Link>
              </Button>
            }
            contextNote="Sources that failed and sources that were accepted but have not reported yet are listed separately: one is a failure, the other is outstanding."
          />
        )}

        {results.evidence.omissions.length > 0 ? (
          <Alert>
            <Info aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Sources expected but absent from this bundle</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {results.evidence.omissions.map((omission) => (
                  <li key={omission}>{omission}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {results.evidence.truncations.length > 0 ? (
          <Alert>
            <Info aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Some source lists were shortened</AlertTitle>
            <AlertDescription>
              The counts and the window stay exact; the stored list of row
              references is a prefix:
              <ul className="list-disc pl-5">
                {results.evidence.truncations.map((truncation) => (
                  <li key={truncation}>{truncation}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      {/* ── Trend cards ────────────────────────────────────────────────── */}
      <section aria-labelledby="trends-heading" className="space-y-3">
        <h2 id="trends-heading" className="text-subsection font-semibold tracking-tight">
          Trend cards
        </h2>

        <FilterBar
          defaults={FILTER_DEFAULTS}
          value={filters}
          onChange={setFilters}
          hideSearch
          controls={[
            ...(engineOptions.length > 0
              ? [{ kind: 'select' as const, key: 'engine', label: 'Engine', options: engineOptions, allLabel: 'All engines' }]
              : []),
            ...(marketOptions.length > 0
              ? [{ kind: 'select' as const, key: 'market', label: 'Market', options: marketOptions, allLabel: 'All markets' }]
              : []),
            { kind: 'select' as const, key: 'trend', label: 'State', options: TREND_OPTIONS, allLabel: 'Measured and unmeasured' },
          ]}
          summary={
            <span>
              {isFiltered
                ? `Showing ${visibleMetrics.length} of ${results.metrics.length} metrics`
                : `${results.metrics.length} metrics`}
            </span>
          }
        />

        {visibleMetrics.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="no-results"
                onClearFilters={() =>
                  setFilters({ engine: FILTER_ALL, market: FILTER_ALL, trend: FILTER_ALL })
                }
              />
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {visibleMetrics.map((metric) => (
              <MetricCard
                key={metric.key}
                metric={metric}
                comparability={comparability}
                coverage={coverage}
                freshness={results.evidence.freshness}
                timeZone={results.window.timezone}
                generatedAt={results.generatedAt}
                windowLabel={results.window.label ?? `${results.window.days}-day window`}
                manifestId={results.evidence.manifestId}
              />
            ))}
          </div>
        )}

        <p className="text-meta text-muted-foreground">
          Every card is labelled with the data window and gate behind it. An
          engine or market filter narrows the cards to the metrics measured over
          that scope — it never splits a number, because each value is computed
          once over the cohort named above.
        </p>
      </section>

      {/* ── Comparison ─────────────────────────────────────────────────── */}
      <section aria-labelledby="comparison-heading" className="space-y-3">
        <h2 id="comparison-heading" className="text-subsection font-semibold tracking-tight">
          Compared with the previous period
        </h2>
        <ComparisonSection
          comparability={comparability}
          windowEndsOn={results.window.endsOn}
          windowId={results.window.periodId ?? 'current-window'}
        />
      </section>

      {/* ── Business outcomes ──────────────────────────────────────────── */}
      <section aria-labelledby="outcomes-heading" className="space-y-3">
        <h2 id="outcomes-heading" className="text-subsection font-semibold tracking-tight">
          Business outcomes
        </h2>
        <Card>
          <CardContent className="space-y-3 py-4">
            {/* Always the not-measured branch: the system has no conversion
                linkage yet, and §6.4 forbids implying a causal business result. */}
            <EmptyState
              variant="not-measured"
              subject="revenue, pipeline or conversion outcomes"
              prerequisite={results.businessOutcomes.prerequisite}
            />
            <p className="text-table text-muted-foreground">{results.businessOutcomes.reason}</p>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="Model-answer engagement">
                {formatNumber(results.businessOutcomes.presentRows.aiAttributedResponses.count)}
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  {results.businessOutcomes.presentRows.aiAttributedResponses.whatItIs}
                </span>
                <span className="block text-meta text-muted-foreground">
                  {results.businessOutcomes.presentRows.aiAttributedResponses.whatItIsNot}
                </span>
              </Fact>
              <Fact label="Sales pipeline">
                <span className="text-unmeasured-foreground">
                  {results.businessOutcomes.presentRows.cailyxLeadPipeline.whatItIs}
                </span>
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  {results.businessOutcomes.presentRows.cailyxLeadPipeline.whatItIsNot}
                </span>
              </Fact>
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* ── Disclosure ─────────────────────────────────────────────────── */}
      <section aria-labelledby="disclosure-heading" className="space-y-3">
        <h2 id="disclosure-heading" className="text-subsection font-semibold tracking-tight">
          What is not in this view, and why
        </h2>
        <Card>
          <CardContent className="space-y-4 py-4">
            <div>
              <h3 className="text-table font-semibold">Deliberately omitted</h3>
              <ul className="mt-1 space-y-1 text-table text-muted-foreground">
                {results.disclosure.omitted.map((entry) => (
                  <li key={entry.key}>{entry.reason}</li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-table font-semibold">Still collecting</h3>
              {results.disclosure.pending.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  Nothing is outstanding — every source that started has reported.
                </p>
              ) : (
                <ul className="mt-1 space-y-1 text-table">
                  {results.disclosure.pending.map((entry) => (
                    <li key={entry.id} className="text-muted-foreground">
                      {entry.sourceType} · {entry.status} — {entry.detail}
                      {entry.observedAt ? (
                        <>
                          {' '}
                          (since <Timestamp value={entry.observedAt} dateOnly />)
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-table font-semibold">Collection that failed</h3>
              {results.disclosure.failed.length === 0 ? (
                <p className="text-table text-muted-foreground">No collection failed in this window.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-table">
                  {results.disclosure.failed.map((entry) => (
                    <li key={entry.id} className="text-danger-foreground">
                      {entry.sourceType} · {entry.status} — {entry.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {results.disclosure.caveats.length > 0 ? (
              <div>
                <h3 className="text-table font-semibold">Caveats that apply to these numbers</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-table text-muted-foreground">
                  {results.disclosure.caveats.map((caveat) => (
                    <li key={caveat}>{caveat}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <h3 className="text-table font-semibold">How to read these figures</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-table text-muted-foreground">
                {results.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </section>

      {loading ? <p className="sr-only">Refreshing results…</p> : null}

      <p className="text-meta text-muted-foreground">
        Looking for a frozen version of these figures? Released reports are
        snapshots that later runs cannot change — see{' '}
        <Link href="/client/reports" className="text-primary underline underline-offset-4">
          Reports
        </Link>
        .
      </p>
    </div>
  );
}

// ── One metric ──────────────────────────────────────────────────────────

/**
 * Which pinned source a metric key is computed from, so a tile can carry the
 * date of *its own* evidence.
 *
 * Where a key has no single source, no date is invented: the tile falls back to
 * "the newest source date in this window", labelled as exactly that. §6.3's rule
 * is that a latest-source timestamp is never presented as something else, so the
 * two cases are deliberately distinguishable in the label.
 */
const SOURCE_FOR_METRIC: Partial<Record<string, PortalEvidenceSourceType>> = {
  rubricScore: 'score-run',
  mentionRate: 'observation',
  citationRate: 'observation',
  shareOfVoice: 'observation',
  observations: 'observation',
  crawlerActivity: 'crawler-hit',
  referringDomains: 'backlinks-summary',
};

function MetricCard({
  metric,
  comparability,
  coverage,
  freshness,
  timeZone,
  generatedAt,
  windowLabel,
  manifestId,
}: {
  metric: PortalMetric;
  comparability: PortalComparability;
  coverage: ReturnType<typeof coverageSummaryFromEvidence>;
  freshness: PortalResultsView['evidence']['freshness'];
  timeZone: string;
  generatedAt: string;
  windowLabel: string;
  manifestId: string | null;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const measured = metric.state === 'measured';
  const delta =
    comparability.state === 'comparable'
      ? comparability.deltas.find((entry) => entry.key === metric.key)
      : undefined;

  const baseline =
    comparability.state === 'comparable' &&
    delta &&
    delta.state === 'measured' &&
    measured
      ? {
          comparable: true as const,
          value: delta.baseline,
          runId: comparability.baseline.periodId,
          runDate: comparability.baseline.endsOn,
          label: comparability.baseline.label,
        }
      : undefined;

  const deltaMode =
    metric.unit === 'percentage-points' || metric.unit === 'ratio'
      ? ('percentage-points' as const)
      : ('absolute' as const);

  const scopeNote = describeScope(metric);
  const sourceType = SOURCE_FOR_METRIC[metric.key];
  const ownSourceDate = sourceType ? freshness.perSource[sourceType] : undefined;
  const sourceDate = ownSourceDate
    ? { date: ownSourceDate, sourceName: EVIDENCE_SOURCE_LABEL[sourceType as PortalEvidenceSourceType] }
    : freshness.latestSourceObservedAt
      ? {
          date: freshness.latestSourceObservedAt,
          sourceName: 'Newest source date in this window (not this metric’s own timestamp)',
        }
      : undefined;

  return (
    <MetricTile
      label={metric.label}
      // The only way a value reaches the tile is through the measured branch.
      value={measured ? metric.value : null}
      unit={unitLabel(metric.unit)}
      formatValue={metric.unit === 'ratio' ? (value) => formatPercent(value * 100) : undefined}
      windowLabel={windowLabel}
      runLabel={metric.scope.methodologyHash ? `methodology ${shortHash(metric.scope.methodologyHash)}` : undefined}
      sourceDate={sourceDate}
      timeZone={timeZone}
      coverage={coverage ?? undefined}
      baseline={baseline}
      deltaMode={deltaMode}
      // Nothing here declares which direction is good — §6.4 forbids invented significance.
      direction="neutral"
      provenance="measured"
      note={
        <>
          <span className="block">{metric.definition}</span>
          {measured ? (
            <span className="mt-1 block">
              {metric.denominator !== undefined && metric.numerator !== undefined
                ? `${formatNumber(metric.numerator)} of ${formatNumber(metric.denominator)}`
                : null}
              {metric.denominator !== undefined ? ' · ' : ''}
              {metric.sample.observations} observation
              {metric.sample.observations === 1 ? '' : 's'} across {metric.sample.prompts} prompt
              {metric.sample.prompts === 1 ? '' : 's'}
              {metric.sample.meetsSamplingFloor
                ? ` (meets the floor of ${metric.sample.samplingFloor} repeats per prompt — a sampling floor, not a significance test)`
                : ` (below the floor of ${metric.sample.samplingFloor} repeats per prompt)`}
            </span>
          ) : (
            <span className="mt-1 block">
              {metric.reason} Required first: {metric.prerequisite}
            </span>
          )}
          {scopeNote ? <span className="mt-1 block">{scopeNote}</span> : null}
          {metric.notes.map((note) => (
            <span key={note} className="mt-1 block">
              {note}
            </span>
          ))}
        </>
      }
      evidence={
        <EvidenceDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          title={`${metric.label} — ${windowLabel}`}
          trigger={
            // The drawer is caller-controlled by contract, so the trigger
            // carries the handler — the docked panel does not open itself.
            <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)}>
              Evidence
            </Button>
          }
          source={{
            name: 'Results read',
            capturedAt: generatedAt,
            runId: manifestId ?? undefined,
          }}
          observed={
            measured ? (
              <span>
                {formatMetricValue(metric)} — measured over {windowLabel}, computed from{' '}
                {metric.sample.observations} observation
                {metric.sample.observations === 1 ? '' : 's'}.
              </span>
            ) : (
              <span>
                Not measured. {metric.reason}
              </span>
            )
          }
          interpretation={metric.definition}
          raw={{
            label: 'The metric as returned by the results read',
            text: JSON.stringify(metric, null, 2),
          }}
          confidence={{
            level: 'unknown',
            basis:
              'No confidence level is established for this metric. The system records how much it sampled — not how certain it is — and §6.4 forbids inventing significance.',
          }}
          provenance="measured"
          timeZone={timeZone}
        />
      }
    />
  );
}

// ── Comparison ──────────────────────────────────────────────────────────

function ComparisonSection({
  comparability,
  windowEndsOn,
  windowId,
}: {
  comparability: PortalComparability;
  windowEndsOn: string;
  windowId: string;
}) {
  if (comparability.state === 'no-baseline') {
    return (
      <Card>
        <CardContent className="py-4">
          <EmptyState
            variant="no-comparison-baseline"
          >
            <p>{comparability.reason}</p>
            <p className="mt-1">Required first: {comparability.prerequisite}</p>
          </EmptyState>
        </CardContent>
      </Card>
    );
  }

  const baseline = comparability.baseline;
  const differingChecks = comparability.checks.filter((check) => !check.same);

  if (comparability.state === 'methodology-break') {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Not comparable — the change figure is withheld</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{comparability.withheld}</p>
            <p>{comparability.reason}</p>
            <p className="text-meta">
              The comparison key this period was measured against:{' '}
              {baseline.label}, {formatIso(baseline.startsOn)} to {formatIso(baseline.endsOn)}.
            </p>
            {comparability.withheldMetricKeys.length > 0 ? (
              <p className="text-meta">
                Withheld for: {comparability.withheldMetricKeys.join(', ')}. Those
                metrics are still shown above as measured values — what is
                missing is the movement between two runs that are not measuring
                the same thing.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">What changed in the comparison key</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {differingChecks.map((check) => (
                <li key={check.key} className="py-2 text-table">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{check.label}</span>
                    {check.isBreak ? (
                      <span className="text-meta font-medium text-danger-foreground">
                        breaks comparability
                      </span>
                    ) : (
                      <span className="text-meta text-muted-foreground">differs, not a break</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-meta text-muted-foreground">
                    This period: {check.current ?? 'not recorded'} · baseline:{' '}
                    {check.baseline ?? 'not recorded'}
                  </div>
                  <div className="text-meta text-muted-foreground">{check.note}</div>
                </li>
              ))}
            </ul>
            {differingChecks.length === 0 ? (
              <p className="text-table text-muted-foreground">
                Every check differs on a key the system does not treat as
                individually comparable, so the two runs are not measuring the
                same thing even though no single difference was recorded as a break.
              </p>
            ) : null}
            {comparability.breaks.length > 0 ? (
              <ul className="mt-3 space-y-1 text-meta text-muted-foreground">
                {comparability.breaks.map((entry, index) => (
                  <li key={`${entry.at}-${index}`}>
                    Recorded <Timestamp value={entry.at} dateOnly /> — {entry.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  const measuredDeltas = comparability.deltas.filter((delta) => delta.state === 'measured');
  const unmeasuredDeltas = comparability.deltas.filter((delta) => delta.state !== 'measured');

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-1 py-4 text-table">
          <p>
            Compared against <span className="font-medium">{baseline.label}</span> (
            <Timestamp value={baseline.startsOn} dateOnly /> –{' '}
            <Timestamp value={baseline.endsOn} dateOnly />), measured over the same
            query set and engines.
          </p>
          <p className="text-meta text-muted-foreground">{comparability.note}</p>
        </CardContent>
      </Card>

      {measuredDeltas.length === 0 ? (
        <Card>
          <CardContent className="py-4">
            <EmptyState
              variant="not-measured"
              subject="a comparable change"
              prerequisite="Both periods are set up to be compared, but no metric produced a change figure."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {measuredDeltas.map((delta) => (
            <ChangeComparison
              key={delta.key}
              data={{
                before: { id: baseline.periodId, date: baseline.endsOn, value: delta.baseline },
                after: { id: windowId, date: windowEndsOn, value: delta.current },
                unit: delta.unit === 'percentage-points' ? '%' : 'points',
                // The check is `=== true`, and this branch only exists because
                // the server said the methodologies match.
                methodologyCompatible: true,
              }}
              changeMode={delta.unit === 'percentage-points' ? 'percentage-points' : 'absolute'}
              direction="neutral"
              methodologyNote={comparability.note}
            />
          ))}
        </div>
      )}

      {unmeasuredDeltas.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Changes that could not be computed</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {unmeasuredDeltas.map((delta) => (
                <li key={delta.key} className="py-2 text-table">
                  <span className="font-medium">{delta.label}</span>
                  <span className="block text-meta text-muted-foreground">
                    {delta.state === 'not-measured' ? delta.reason : null}
                    {delta.state === 'not-measured' ? ` Required first: ${delta.prerequisite}` : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ── Presentation helpers ────────────────────────────────────────────────

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-table">{children}</dd>
    </div>
  );
}

function unitLabel(unit: PortalMetric['unit']): string {
  switch (unit) {
    case 'points':
      return 'points';
    case 'ratio':
      return '%';
    case 'percentage-points':
      return 'pp';
    case 'count':
      return 'count';
    case 'milliseconds':
      return 'ms';
  }
}

function formatMetricValue(metric: PortalMetric): string {
  if (metric.state !== 'measured') return 'Not measured yet';
  switch (metric.unit) {
    case 'ratio':
      return formatPercent(metric.value * 100);
    case 'milliseconds':
      return `${formatNumber(metric.value)} ms`;
    case 'percentage-points':
      return `${formatNumber(metric.value)} pp`;
    case 'count':
      return formatNumber(metric.value);
    case 'points':
    default:
      return `${formatNumber(metric.value)} points`;
  }
}

/** What a metric's own scope says, so a card never implies coverage it did not declare. */
function describeScope(metric: PortalMetric): string | null {
  const parts: string[] = [];
  if (metric.scope.engines.length > 0) parts.push(`engines: ${metric.scope.engines.join(', ')}`);
  if (metric.scope.markets.length > 0) parts.push(`markets: ${metric.scope.markets.join(', ')}`);
  if (parts.length === 0) {
    return 'Engines and markets for this metric are not pinned, so it is not attributable to a specific engine or market.';
  }
  return `Measured over ${parts.join(' · ')}.`;
}

function shortHash(hash: string): string {
  return hash.length > 10 ? `${hash.slice(0, 10)}…` : hash;
}

function formatIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unreadable date';
  return date.toLocaleDateString();
}
