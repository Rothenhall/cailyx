'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ExternalLink, Info, Play, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  getScorecard,
  listScorecards,
  publicScorecardHref,
  runScorecard,
  type ScorecardProblem,
  type ScorecardRun,
} from '@/services/sales';

/**
 * SL05 — Scorecard.
 *
 * design_plan.md §4.2: *"Run free/operator depth, score and three problems,
 * evidence/public token."*
 *
 * ## The three problems are evidence, not marketing
 *
 * §6.1 defines the initial scorecard as *"Rubric result, coverage caveat,
 * exactly three named problems, CTA"*, and §6.3's band rule is explicit that
 * **"Recommended" is a rubric label, not a promise an engine recommends the
 * brand**. Each problem therefore renders its own evidence lines, its dimension
 * value (or an explicit not-measured when the source was missing), and the
 * deterministic fix — the problem is the artifact, the score is a summary of it.
 *
 * ## No delta is drawn, and the reason is on the page
 *
 * §6.4 requires comparison only where the key matches, and a `ScorecardRun`
 * records no rubric version. Without it, two runs' scores cannot be shown to be
 * comparable — so the prior-run list is presented as a list of scores with no
 * change figure and no arrow, and the screen says why. A delta that looks clean
 * but might be a methodology break is worse than no delta.
 *
 * ## Re-running is real work
 *
 * Both depths run a fresh technical audit and persist a new row; it is never a
 * re-read of the last one. The action is explicit, its cost is named, and a
 * second run does not overwrite the first.
 */

const BAND_TONE: Record<string, StatusTone> = {
  invisible: 'danger',
  faint: 'warning',
  present: 'info',
  recommended: 'success',
};

const BAND_MEANING: Record<string, string> = {
  invisible: 'Not present in the evidence this rubric measured.',
  faint: 'Present but weakly; little that would surface the brand.',
  present: 'Present and identifiable, with clear room to improve.',
  recommended: 'The rubric’s own label for this range — not a statement that an engine recommends the brand.',
};

export default function ScorecardRunPage() {
  const params = useParams<{ projectId: string; runId: string }>();
  const router = useRouter();
  const { projectId, runId } = params;

  const [run, setRun] = useState<ScorecardRun | null>(null);
  const [siblings, setSiblings] = useState<ScorecardRun[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [runError, setRunError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busyDepth, setBusyDepth] = useState<'free' | 'operator' | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [result, list] = await Promise.all([
          getScorecard(projectId, runId, { signal }),
          listScorecards(projectId, { signal }),
        ]);
        setRun(result);
        setSiblings(list);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, runId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onRun(depth: 'free' | 'operator') {
    setBusyDepth(depth);
    setRunError(null);
    try {
      const created = await runScorecard(projectId, depth);
      // A new run, not a replacement — so navigate to it rather than mutating
      // this page's record.
      router.push(`/projects/${projectId}/scorecards/${created.id}`);
    } catch (caught) {
      setRunError(toApiError(caught));
      setBusyDepth(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Sales pipeline', href: '/ops/sales' }]}
          title="Scorecard"
        />
        <ErrorState
          error={error}
          onRetry={() => void load()}
          notFoundReason="missing-or-private"
        />
      </div>
    );
  }

  if (!run || !siblings) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const bandTone = BAND_TONE[run.band] ?? 'neutral';
  const others = siblings
    .filter((sibling) => sibling.id !== run.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Sales pipeline', href: '/ops/sales' },
          { label: 'Scorecards' },
          { label: `Run ${run.id.slice(0, 8)}` },
        ]}
        title="Scorecard"
        context={
          <>
            Depth <strong>{run.depth}</strong> · run{' '}
            <Timestamp value={run.createdAt} />
          </>
        }
        status={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={`Band: ${run.band}`} tone={bandTone} />
            {run.nonObvious ? (
              <StatusPill label="Includes a non-obvious problem" tone="info" />
            ) : (
              <StatusPill label="No non-obvious problem flagged" tone="unmeasured" />
            )}
            {run.problems.length !== 3 ? (
              <StatusPill
                label={`${run.problems.length} problems, not 3`}
                tone="warning"
              />
            ) : null}
          </div>
        }
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {runError ? <ErrorState error={runError} layout="inline" /> : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Score</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-kpi tabular-nums font-semibold">{formatNumber(run.score)}</p>
            <p className="text-table">
              Band <strong>{run.band}</strong>
            </p>
            <p className="text-meta text-muted-foreground">
              {BAND_MEANING[run.band] ?? 'This band has no recorded definition.'}
            </p>
            <Separator />
            <p className="text-meta text-muted-foreground">
              The score is the sum of the rubric&rsquo;s dimension contributions.
              It is a summary of the three problems below, not a substitute for
              reading them.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Depth</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-table">
              This run used the <strong>{run.depth}</strong> depth.
            </p>
            <p className="text-meta text-muted-foreground">
              {run.depth === 'operator'
                ? 'The operator depth runs the fuller check set. Its results are for internal use and are not the prospect-facing artifact.'
                : 'The free depth is the low-depth Rung-0 diagnostic a prospect sees. It runs a real technical audit, not a cached one.'}
            </p>
            <Separator />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyDepth !== null}
                onClick={() => void onRun('free')}
              >
                <Play aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
                {busyDepth === 'free' ? 'Running…' : 'Run free diagnostic'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busyDepth !== null}
                onClick={() => void onRun('operator')}
              >
                <Play aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
                {busyDepth === 'operator' ? 'Running…' : 'Run at operator depth'}
              </Button>
            </div>
            <p className="text-meta text-muted-foreground">
              Each run performs a fresh technical audit and writes a new row.
              Neither replaces this one — the run history below keeps both.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Public token</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="font-mono text-meta break-all">{run.publicToken}</p>
            <Button variant="outline" size="sm" asChild>
              <Link href={publicScorecardHref(projectId, run.publicToken)}>
                Open the shared view
                <ExternalLink aria-hidden="true" className="ml-2 h-3.5 w-3.5" />
              </Link>
            </Button>
            {/*
              The token is minted with every run but the public view is gated on
              a deployment flag; a link that may refuse is worse unlabelled.
            */}
            <p className="text-meta text-muted-foreground">
              This path resolves only when the deployment enables public
              scorecards. Until then the route refuses and the token is
              operator-only — the token existing is not the same as the page
              being public.
            </p>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-4" aria-labelledby="scorecard-problems">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="scorecard-problems" className="text-subsection font-semibold">
            Named problems
          </h2>
          <StatusPill
            label={`${run.problems.length}`}
            tone={run.problems.length === 3 ? 'neutral' : 'warning'}
          />
          <p className="text-meta text-muted-foreground">
            The Rung-0 contract is exactly three: a specific problem, the
            evidence behind it, and the deterministic next move.
          </p>
        </div>

        {run.problems.length === 0 ? (
          <EmptyState
            variant="not-measured"
            subject="named problems on this run"
            prerequisite="A completed technical audit. A run that produced no problems has no findings to act on."
          />
        ) : (
          <ol className="space-y-4">
            {run.problems.map((problem, index) => (
              <ProblemCard key={`${problem.dimension}-${index}`} problem={problem} index={index} />
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="scorecard-history">
        <h2 id="scorecard-history" className="text-subsection font-semibold">
          Run history
        </h2>
        {others.length === 0 ? (
          <EmptyState variant="no-comparison-baseline" layout="panel" />
        ) : (
          <>
            <p className="text-meta text-muted-foreground">
              Other runs for this project. Scores are listed without a change
              figure: a scorecard run records no rubric version, so two runs
              cannot be shown to be comparable, and a delta between
              incomparable runs is a number that looks meaningful and is not.
            </p>
            <ul className="space-y-2">
              {others.map((sibling) => (
                <li
                  key={sibling.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-table tabular-nums font-semibold">
                      {formatNumber(sibling.score)}
                    </span>
                    <StatusPill
                      label={sibling.band}
                      tone={BAND_TONE[sibling.band] ?? 'neutral'}
                    />
                    <span className="text-meta text-muted-foreground">
                      {sibling.depth} depth
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-meta text-muted-foreground">
                      <Timestamp value={sibling.createdAt} />
                    </span>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/projects/${projectId}/scorecards/${sibling.id}`}>
                        Open
                      </Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * One named problem.
 *
 * `value: null` is rendered as §6.3's "not measured", never as zero: a dimension
 * whose source evidence was missing did not score poorly, it did not score.
 */
function ProblemCard({ problem, index }: { problem: ScorecardProblem; index: number }) {
  return (
    <li className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-table font-medium">
            {index + 1}. {problem.dimension}
          </h3>
          <p className="mt-1 text-table">{problem.why}</p>
        </div>
        <div className="text-right">
          <p className="text-meta text-muted-foreground">Dimension value</p>
          <p className="text-table tabular-nums font-semibold">
            {problem.value === null ? notMeasuredLabel() : formatNumber(problem.value)}
          </p>
        </div>
      </div>

      {problem.value === null ? (
        <Alert className="mt-3">
          <Info aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>
            The source evidence for this dimension was missing, so it was not
            measured. Under the rubric it contributes zero — which is why a
            partial run&rsquo;s score reads lower than the same site would with
            every check complete.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-3">
        <h4 className="text-meta font-medium text-muted-foreground">Next move</h4>
        <p className="mt-1 text-table">{problem.fix}</p>
      </div>

      <div className="mt-3">
        <h4 className="text-meta font-medium text-muted-foreground">
          Evidence ({problem.evidence.length})
        </h4>
        {problem.evidence.length === 0 ? (
          <p className="mt-1 text-table text-muted-foreground">
            No evidence line was recorded for this problem. That is worth
            treating as a gap in the run rather than as a confident finding.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {problem.evidence.map((line, lineIndex) => (
              <li
                key={`${line}-${lineIndex}`}
                className="font-mono text-meta break-words text-muted-foreground"
              >
                {/*
                  Reproduction-grade lines are rendered as text, not markup —
                  they come from a fetched page (§10.5).
                */}
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
