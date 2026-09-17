'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, formatPercent, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  getAeoVisibilityHistory,
  getAeoVisibilityQuestions,
  getAeoVisibilitySummary,
  type AeoCustomerQuestion,
  type AeoCustomerQuestionsPage,
  type AeoVisibilityHistoryEntry,
  type AeoVisibilitySummary,
} from '@/services/research';

/**
 * AE01 — AI visibility (merged).
 *
 * P13 (platform_improvement_plan.md §8, and the P13 row in §20.2) merges the
 * former "AI visibility" hub and "Prompt library" into ONE client-facing
 * destination with three views:
 *
 *  - **Summary** — score/mention rate where valid, questions checked,
 *    locations, dates, plain-English status (§8.1).
 *  - **Customer questions** — questions grouped by business topic, with
 *    observed appearance/recommendation results (§8.1).
 *  - **History** — comparable measurements and meaningful changes; a question-
 *    set version change is disclosed as an explicit comparability break, never
 *    silently averaged into a continuous-looking chart (§8.2).
 *
 * Everything here is composed server-side by `GET .../aeo/visibility/*` from
 * data `aeo-audit` already stores (audit/verdict, the versioned QuerySet
 * matrix, and `measurement`'s Observations) — no new measurement, and no raw
 * model answers: those stay behind the staff-only run detail
 * (`/research/ai/runs/:auditId`) and observation reader this merge does not
 * widen (§8.1: "Clients should not receive raw answers merely because a
 * prompt detail page was merged").
 *
 * §8.3 — the competitor boundary — is a single contextual link into
 * Competitors carrying topic/market/period, never a second comparison table
 * here.
 *
 * Raw run administration (every `AeoAudit` row, including in-flight/failed
 * ones) and question-set curation stay staff-only secondary detail, linked
 * from here rather than folded into the main view (§8.1, §8.2's "advanced
 * staff panel").
 */
const TAB_DEFAULTS = { view: 'summary' };

export default function AiVisibilityPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [tab, setTab] = useUrlState(TAB_DEFAULTS);

  const [summary, setSummary] = useState<AeoVisibilitySummary | null>(null);
  const [summaryError, setSummaryError] = useState<ApiError | null>(null);
  const [summaryNotFound, setSummaryNotFound] = useState(false);

  const loadSummary = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setSummaryError(null);
        setSummaryNotFound(false);
        setSummary(await getAeoVisibilitySummary(projectId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const apiError = toApiError(caught);
        if (apiError.kind === 'not-found') {
          setSummaryNotFound(true);
          return;
        }
        setSummaryError(apiError);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary]);

  if (summaryError) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI visibility" />
        <ErrorState error={summaryError} onRetry={() => void loadSummary()} />
      </div>
    );
  }

  if (!summary && !summaryNotFound) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: 'This project', mode: 'live' }} />

      <PageHeader
        title="AI visibility"
        context={
          summary
            ? `${summary.markets.length ? summary.markets.join(', ') : 'Market not recorded'} · ${
                summary.period.finishedAt ? summary.period.finishedAt.slice(0, 10) : 'Not dated'
              }`
            : 'No measurement yet'
        }
        primaryAction={{ label: 'Update AI results', href: `/projects/${projectId}/research/ai/new` }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/research/ai/sets`}>Manage question sets (staff)</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/research/ai/runs`}>Run administration (staff)</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void loadSummary()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {summaryNotFound ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="AI visibility"
              prerequisite="An AEO run needs an approved question set and a configured engine before there is anything to summarize."
              action={{ label: 'Set up the first run', href: `/projects/${projectId}/research/ai/new` }}
            />
          </CardContent>
        </Card>
      ) : summary ? (
        <Tabs value={tab.view} onValueChange={(value) => setTab({ view: value })}>
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="questions">Customer questions</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="summary">
            <SummaryView projectId={projectId} summary={summary} />
          </TabsContent>
          <TabsContent value="questions">
            <QuestionsView projectId={projectId} auditId={summary.auditId} />
          </TabsContent>
          <TabsContent value="history">
            <HistoryView projectId={projectId} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}

// ─── Summary view (§8.1) ────────────────────────────────────────────────

function SummaryView({ projectId, summary }: { projectId: string; summary: AeoVisibilitySummary }) {
  return (
    <div className="space-y-6 pt-4">
      {summary.status !== 'completed' ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>This measurement is {summary.status}</AlertTitle>
          <AlertDescription>
            The figures below describe the answers that were received so far. No significance is claimed
            beyond that.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="text-kpi font-semibold text-foreground">{summary.headline}</p>
          <p className="text-table text-muted-foreground">
            &ldquo;Appeared&rdquo; and &ldquo;recommended&rdquo; are separate measures and are never combined
            into one rate. Cailyx does not claim an ordered &ldquo;#1 in AI&rdquo; ranking unless the
            measurement itself defines and supports a position — this one does not.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <MetricCard
          title="Questions checked"
          value={`${formatNumber(summary.questionsChecked)} of ${formatNumber(summary.totalQuestions)}`}
          note="Questions with at least one stored answer, against the current question set."
        />
        <MetricCard
          title="Appeared"
          value={
            summary.appeared.rateValid
              ? `${formatPercent((summary.appeared.count / summary.appeared.of) * 100)} of questions`
              : notMeasuredLabel()
          }
          note={
            summary.appeared.rateValid
              ? `${formatNumber(summary.appeared.count)} of ${formatNumber(summary.appeared.of)} checked questions named the business in at least one answer.`
              : 'No question has been checked yet.'
          }
        />
        <MetricCard
          title="Recommended"
          value={
            summary.recommended && summary.recommended.rateValid
              ? `${formatPercent((summary.recommended.count / summary.recommended.of) * 100)} of judged answers`
              : notMeasuredLabel()
          }
          note={
            summary.recommended && summary.recommended.rateValid
              ? `${formatNumber(summary.recommended.count)} of ${formatNumber(summary.recommended.of)} judged answers recommended the business — a judged opinion, never a counted rate.`
              : 'Recommendation has not been judged for this measurement yet.'
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Locations and dates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2 text-table">
          <p>
            <span className="text-muted-foreground">Locations checked: </span>
            {summary.markets.length ? summary.markets.join(', ') : 'Not recorded'}
          </p>
          <p>
            <span className="text-muted-foreground">Started: </span>
            {summary.period.startedAt ? <Timestamp value={summary.period.startedAt} /> : notMeasuredLabel()}
          </p>
          <p>
            <span className="text-muted-foreground">Finished: </span>
            {summary.period.finishedAt ? <Timestamp value={summary.period.finishedAt} /> : notMeasuredLabel()}
          </p>
          {/*
            §8.3 — the competitor boundary. A single contextual link carrying
            the current market/period, never a second comparison table here:
            "Detailed rival tables... belong in Competitors." P06 already owns
            /research/competitors/compare and its own gap/snapshot reads; this
            link only navigates, it does not fetch competitor data.
          */}
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/projects/${projectId}/research/competitors/compare?${new URLSearchParams({
                ...(summary.markets[0] ? { market: summary.markets[0] } : {}),
                ...(summary.period.finishedAt ? { period: summary.period.finishedAt.slice(0, 10) } : {}),
              }).toString()}`}
            >
              Compare with competitors
            </Link>
          </Button>
        </CardContent>
      </Card>

      {summary.disclosedFailures.length > 0 ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Not every engine or location produced a clean measurement</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {summary.disclosedFailures.map((f, i) => (
                <li key={`${f.surface}-${f.market ?? 'any'}-${i}`}>
                  {f.label}
                  {f.market ? ` (${f.market})` : ''}: {f.reason}
                </li>
              ))}
            </ul>
            These are named, not dropped from the count — the figures above are over the answers that
            actually came back.
          </AlertDescription>
        </Alert>
      ) : null}

      {summary.headlines.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">In plain language</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="list-disc space-y-0.5 pl-5 text-table text-foreground">
              {summary.headlines.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Methodology (recorded in full, shown in plain words above)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-2 text-table">
          <p className="text-muted-foreground">
            Question set v{summary.methodology.questionSetVersion} ({summary.methodology.samplingConfig.tier} tier,
            n={summary.methodology.samplingConfig.runCount} repeats per question).
          </p>
          <ul className="divide-y divide-border">
            {summary.methodology.surfaces.map((s, i) => (
              <li key={`${s.surface}-${s.market ?? 'any'}-${i}`} className="flex items-center justify-between gap-4 py-1.5">
                <span>
                  {s.label}
                  {s.market ? ` · ${s.market}` : ''}
                </span>
                <span className="text-meta text-muted-foreground">
                  {s.accessMode} · <StatusPill label={s.status} tone={surfaceTone(s.status)} />
                </span>
              </li>
            ))}
          </ul>
          <Link
            href={`/projects/${projectId}/research/ai/runs/${summary.auditId}`}
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Open the full run detail (staff)
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-2">
        <p className="text-kpi font-semibold tabular-nums text-foreground">{value}</p>
        <p className="text-meta text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

function surfaceTone(status: string): StatusTone {
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

// ─── Customer questions view (§8.1, §8.4) ──────────────────────────────

const TOPICS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All topics' },
  { value: 'service-discovery', label: 'Service discovery' },
  { value: 'category-best-of', label: 'Category / best-of' },
  { value: 'competitor-alternatives', label: 'Competitor alternatives' },
  { value: 'head-to-head', label: 'Head-to-head comparison' },
  { value: 'brand-direct', label: 'Brand direct' },
  { value: 'problem-framed', label: 'Problem framed' },
  { value: 'buying-criteria', label: 'Buying criteria' },
  { value: 'objection-trust', label: 'Objection / trust' },
  { value: 'job-to-be-done', label: 'Job to be done' },
  { value: 'geo-vertical', label: 'Geo / vertical' },
];

function QuestionsView({ projectId, auditId }: { projectId: string; auditId: string }) {
  const [topic, setTopic] = useState('all');
  const [page, setPage] = useState<AeoCustomerQuestionsPage | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const currentCursor = cursorStack[cursorStack.length - 1];

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await getAeoVisibilityQuestions(projectId, {
          auditId,
          topic: topic === 'all' ? undefined : topic,
          cursor: currentCursor ?? undefined,
          limit: 25,
          signal,
        });
        setPage(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, auditId, topic, currentCursor],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setCursorStack([null]);
  }, [topic]);

  const grouped = useMemo(() => {
    if (!page) return new Map<string, AeoCustomerQuestion[]>();
    const map = new Map<string, AeoCustomerQuestion[]>();
    for (const item of page.items) {
      const bucket = map.get(item.topicLabel);
      if (bucket) bucket.push(item);
      else map.set(item.topicLabel, [item]);
    }
    return map;
  }, [page]);

  if (error) return <div className="pt-4"><ErrorState error={error} onRetry={() => void load()} /></div>;

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={topic} onValueChange={setTopic}>
          <SelectTrigger className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TOPICS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {page ? (
          <p className="text-meta text-muted-foreground">
            Question set v{page.querySetVersion} ({page.querySetStatus}) · {formatNumber(page.pageInfo.total)} question
            {page.pageInfo.total === 1 ? '' : 's'} in this topic
          </p>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link
            href={`/projects/${projectId}/research/competitors/compare?${new URLSearchParams(
              topic === 'all' ? {} : { topic },
            ).toString()}`}
          >
            Compare with competitors
          </Link>
        </Button>
      </div>

      {!page ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : page.items.length === 0 ? (
        <EmptyState variant="no-results" />
      ) : (
        <div className="space-y-6">
          {[...grouped.entries()].map(([topicLabel, items]) => (
            <Card key={topicLabel}>
              <CardHeader>
                <CardTitle className="text-subsection">{topicLabel}</CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <ul className="divide-y divide-border">
                  {items.map((q) => (
                    <li key={q.id} className="space-y-2 py-3">
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => setExpanded(expanded === q.id ? null : q.id)}
                      >
                        <p className="text-table text-foreground">{q.prompt}</p>
                        <p className="text-meta text-muted-foreground">
                          {!q.checked ? (
                            'Not checked'
                          ) : (
                            <>
                              Appeared in {formatNumber(q.appearedCount)} of {formatNumber(q.attempts)} answers
                              {q.recommendedCount !== null ? (
                                <> · Recommended in {formatNumber(q.recommendedCount)} of {formatNumber(q.attempts)} judged</>
                              ) : null}
                              {q.checkedAt ? (
                                <>
                                  {' '}
                                  · Checked <Timestamp value={q.checkedAt} />
                                </>
                              ) : null}
                            </>
                          )}
                        </p>
                      </button>
                      {expanded === q.id ? (
                        <div className="rounded-md border border-border bg-muted/30 p-3 text-meta">
                          <p className="mb-1 text-foreground">
                            Topic: {q.topicLabel} · Funnel stage: {q.funnelStage} ·{' '}
                            {q.branding ? `${q.branding} prompt` : 'Branding not recorded'}
                          </p>
                          {q.results.length === 0 ? (
                            <p className="text-muted-foreground">
                              Not checked — no answer has been recorded for this question yet. Nothing is
                              claimed about it above.
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {q.results.map((r, i) => (
                                <li key={`${r.surface}-${r.market ?? 'any'}-${i}`} className="text-muted-foreground">
                                  {r.label}
                                  {r.market ? ` · ${r.market}` : ''}
                                  {r.attemptedVia && r.attemptedVia !== r.surface
                                    ? ` (fallback: ${r.attemptedVia})`
                                    : ''}
                                  : {r.mentioned ? 'appeared' : 'did not appear'}, {r.cited ? 'cited' : 'not cited'}
                                  {r.stance ? `, stance: ${stanceLabel(r.stance)}` : ''} —{' '}
                                  <Timestamp value={r.checkedAt} />
                                  {/*
                                    §8.1's "safe explanation/source reference": the public
                                    URL the answer cited. A source is never invented — when
                                    no URL was recorded this says so.
                                  */}
                                  {r.cited ? (
                                    r.sourceUrl ? (
                                      <>
                                        {' '}
                                        · source:{' '}
                                        <a
                                          href={r.sourceUrl}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                          className="text-primary underline underline-offset-4"
                                        >
                                          {r.sourceUrl}
                                        </a>
                                      </>
                                    ) : (
                                      <> · source: the URL was not recorded</>
                                    )
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="mt-2 text-muted-foreground">
                            The source links above are public pages the answers themselves cited. Verbatim
                            model answers stay staff detail on the run record — merging this screen in did
                            not expose raw answers to anyone who could not already read them.
                          </p>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={cursorStack.length <= 1}
          onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!page?.pageInfo.hasMore}
          onClick={() => page?.pageInfo.nextCursor && setCursorStack((stack) => [...stack, page.pageInfo.nextCursor])}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function stanceLabel(stance: string): string {
  switch (stance) {
    case 'recommended-primary':
      return 'led the answer';
    case 'recommended-alternative':
      return 'one option among others';
    case 'mentioned-neutral':
      return 'named, no endorsement';
    case 'mentioned-negative':
      return 'named with a caveat';
    case 'absent':
      return 'not named';
    default:
      return stance;
  }
}

// ─── History view (§8.2 comparability break) ───────────────────────────

function HistoryView({ projectId }: { projectId: string }) {
  const [history, setHistory] = useState<AeoVisibilityHistoryEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await getAeoVisibilityHistory(projectId, { signal });
        setHistory(result.history);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) return <div className="pt-4"><ErrorState error={error} onRetry={() => void load()} /></div>;
  if (!history) return <Skeleton className="mt-4 h-64 rounded-xl" />;
  if (history.length === 0) {
    return (
      <div className="pt-4">
        <EmptyState
          variant="not-measured"
          subject="measurement history"
          prerequisite="History appears once a second measurement completes."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-4">
      <p className="text-meta text-muted-foreground">
        Newest first. A question-set version change is disclosed below as an explicit comparability break
        — it is never averaged with the version before it to keep a chart looking continuous.
      </p>
      <ul className="space-y-3">
        {history.map((entry) => (
          <li key={entry.auditId}>
            <Card>
              <CardContent className="space-y-2 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-table font-medium text-foreground">
                    {entry.finishedAt ? <Timestamp value={entry.finishedAt} /> : notMeasuredLabel()} · v
                    {entry.querySetVersion} · {entry.markets.length ? entry.markets.join(', ') : 'Market not recorded'}
                  </p>
                  <Link
                    href={`/projects/${projectId}/research/ai/runs/${entry.auditId}`}
                    className="text-table text-primary underline-offset-4 hover:underline"
                  >
                    Open run (staff)
                  </Link>
                </div>
                <p className="text-table text-muted-foreground">
                  {formatNumber(entry.questionsChecked)} of {formatNumber(entry.totalQuestions)} questions checked ·{' '}
                  {/*
                    §8.4: a measurement that checked nothing says "Not checked".
                    The API returns `appeared: null` for exactly that case — it
                    never sends a 0-of-0 rate this view could render as 0%.
                  */}
                  {entry.appeared
                    ? `appeared in ${formatPercent((entry.appeared.count / entry.appeared.of) * 100)} of them`
                    : 'Not checked'}
                </p>
                {entry.comparabilityBreak ? (
                  <Alert>
                    <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                    <AlertTitle>Comparability break</AlertTitle>
                    <AlertDescription>{entry.comparabilityNote}</AlertDescription>
                  </Alert>
                ) : null}
                {entry.disclosedFailures.length > 0 ? (
                  <p className="text-meta text-warning-foreground">
                    Not measured cleanly: {entry.disclosedFailures.map((f) => `${f.label}${f.market ? ` (${f.market})` : ''}`).join(', ')}.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
