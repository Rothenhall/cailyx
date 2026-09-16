'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ApiError } from '@/lib/api';
import type { CoverageSummary } from '@/types';
import {
  deleteJourney,
  executeJourney,
  getJourney,
  getResearchScope,
  parseJsonColumn,
  type Journey,
  type JourneyStep,
  type ResearchScope,
} from '@/services/research-library';

/**
 * JO02 — Journey detail.
 *
 * design_plan.md §4.3: *"Branch/step tree, engine answers, subject/competitor
 * evidence, cost cap, errors"*, in the run/evidence-detail family: *"sticky
 * scope/run header, status or comparison pair, section index, evidence table,
 * detail drawer; **raw answer/check behind disclosure**"*.
 *
 * **Every step's answer is model output.** §10.5 forbids letting fetched markup
 * become trusted application markup, and a journey answer is the most obvious
 * place that could go wrong — a model can return HTML, and an answer engine's
 * text is untrusted by definition. So the answer body is rendered through
 * `EvidenceDrawer`, whose `raw.text` prop has no HTML path at all: it is
 * escaped into the `.evidence` utility and there is no prop that could make it
 * a trusted node.
 *
 * Two numbers are kept apart on this screen for the same reason as everywhere
 * else in this set (§1.5): **`position`** is a place in an answer's list when
 * the answer cited the client, and **`mentioned` / `cited`** are booleans about
 * whether the client appeared in the answer at all. Neither is a ranking, and
 * neither is the counted AEO rate — which is computed over all collected
 * answers, on the AI-visibility screens, not here.
 *
 * Coverage is shown with `CoveragePanel` rather than a percentage: a journey
 * that stopped at its cost cap has skipped steps, and naming them with a reason
 * is what §3.5 requires instead of a clean-looking "80% complete".
 */
export default function JourneyDetailPage() {
  const params = useParams<{ projectId: string; journeyId: string }>();
  const { projectId, journeyId } = params;

  const [journey, setJourney] = useState<Journey | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const [executeOpen, setExecuteOpen] = useState(false);
  const [maxCostUsd, setMaxCostUsd] = useState('');
  const [executing, setExecuting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [openStep, setOpenStep] = useState<JourneyStep | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [result] = await Promise.all([
          getJourney(projectId, journeyId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setJourney(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, journeyId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const steps = useMemo(() => journey?.steps ?? [], [journey]);

  const tree = useMemo(() => buildTree(steps), [steps]);

  /**
   * Step outcomes as evidence coverage. `expected` is every planned step;
   * skipped steps are *deferred* (accepted but not measured) and failed ones are
   * failures — separate lists, exactly as `CoveragePanel` requires.
   */
  const coverage = useMemo<CoverageSummary | null>(() => {
    if (!journey) return null;
    const done = steps.filter((step) => step.status === 'done');
    const failed = steps.filter((step) => step.status === 'failed');
    const skipped = steps.filter((step) => step.status === 'skipped');
    return {
      expectedCount: journey.stepCount,
      successfulCount: done.length,
      failed: failed.map((step) => ({
        name: step.query,
        // The backend stores no per-step failure reason; saying so is better
        // than inventing one, and the journey's own error is shown above.
        reason: 'The surface call for this step failed, so no answer was stored.',
      })),
      deferred: skipped.map((step) => ({
        name: step.query,
        reason: journey.note
          ? `Skipped when execution stopped — ${journey.note}`
          : 'Skipped when execution stopped before this step ran.',
      })),
    };
  }, [journey, steps]);

  const citedUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const step of steps) {
      for (const url of parseJsonColumn<string[]>(step.citations, 'array') ?? []) urls.add(url);
    }
    return [...urls];
  }, [steps]);

  async function handleExecute() {
    setExecuting(true);
    setActionError(null);
    try {
      const parsed = maxCostUsd.trim() === '' ? undefined : Number(maxCostUsd);
      await executeJourney(
        projectId,
        journeyId,
        parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      );
      setExecuteOpen(false);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setExecuting(false);
    }
  }

  async function handleDelete() {
    setActionError(null);
    try {
      await deleteJourney(projectId, journeyId);
      window.location.assign(`/projects/${projectId}/research/journeys`);
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Journey" />
        <ErrorState error={error} notFoundReason="missing-or-private" onRetry={() => void load()} />
      </div>
    );
  }

  if (!journey) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const canExecute = journey.status !== 'completed' && journey.status !== 'running';

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          market: journey.geo,
          projectName: scope?.projectName,
          runLabel: `Journey ${journey.label} · ${journey.surface} surface`,
          mode: 'live',
        }}
        actions={
          <span className="text-meta text-muted-foreground">
            Planned <Timestamp value={journey.plannedAt} /> · by {journey.planSource}
          </span>
        }
      />
      {scopeReadFailed ? (
        <p className="text-meta text-muted-foreground">
          The project context could not be read, so the client and domain are not shown above.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Buyer journeys', href: `/projects/${projectId}/research/journeys` },
          { label: journey.label },
        ]}
        title={journey.label}
        context={journey.objective}
        status={
          <>
            <StatusPill label={journeyStatusLabel(journey.status)} tone={journeyStatusTone(journey.status)} />
            <ProvenanceBadge
              kind={journey.planSource === 'llm' ? 'model-interpretation' : 'derived'}
              label={
                journey.planSource === 'llm'
                  ? `Tree planned by a model${journey.planModel ? ` (${journey.planModel})` : ''}`
                  : 'Tree planned deterministically'
              }
            />
          </>
        }
        primaryAction={{
          label: executing ? 'Executing…' : 'Execute journey',
          onClick: () => setExecuteOpen(true),
          disabled: !canExecute,
          disabledReason:
            journey.status === 'completed'
              ? 'This journey has already completed — its steps are all done.'
              : 'This journey is currently running. Wait for it to finish before starting it again.',
        }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          </div>
        }
      />

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      {journey.error ? (
        <Alert>
          <AlertTitle>Execution error</AlertTitle>
          <AlertDescription>
            <p className="evidence">{journey.error}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {journey.note ? (
        <Alert>
          <AlertTitle>Execution stopped before every step ran</AlertTitle>
          <AlertDescription>
            <p className="evidence">{journey.note}</p>
            <p className="mt-1 text-meta">
              A stopped journey is partial: the steps that did run are real evidence, and the ones
              that did not are named below rather than averaged away.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Run configuration and spend</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <dl className="grid gap-x-8 gap-y-3 text-table sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-meta text-muted-foreground">Surface</dt>
              <dd>
                {journey.surface === 'mock'
                  ? 'Mock — deterministic, no live provider call'
                  : journey.surface}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Geography</dt>
              <dd>{journey.geo}</dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Depth and branches</dt>
              <dd>
                depth {journey.maxDepth} · branches {journey.maxBranches}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Spend so far</dt>
              <dd className="tabular-nums">{formatCurrency(journey.costUsd, 'USD')}</dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Started</dt>
              <dd>
                {journey.startedAt ? (
                  <Timestamp value={journey.startedAt} />
                ) : (
                  <span className="text-muted-foreground">Not started</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Finished</dt>
              <dd>
                {journey.finishedAt ? (
                  <Timestamp value={journey.finishedAt} />
                ) : (
                  <span className="text-muted-foreground">Not finished</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-meta text-muted-foreground">
            Execution stops at a USD cap: the server&rsquo;s default for a run, or the override given
            when it was started. Remaining steps become skipped rather than being silently dropped.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Step coverage</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {!coverage || coverage.expectedCount === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="Step coverage"
              prerequisite="This journey has no planned steps, so there is nothing to execute or measure."
              layout="inline"
            />
          ) : (
            <CoveragePanel
              summary={coverage}
              contextNote={
                <>
                  Expected steps come from the plan; successful ones are the steps whose answer was
                  collected. Failed and skipped steps are listed separately because they mean
                  different things — one is a call that broke, the other is work the cost cap
                  stopped.
                </>
              }
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Step tree</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-meta text-muted-foreground">
            Each step is a search the persona would run next. The tree is ordered by depth, then by
            the order siblings were planned. Answers are shown behind a disclosure and are rendered
            as escaped text — a model&rsquo;s answer is untrusted content and never becomes markup on
            this page.
          </p>
          {tree.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="Step tree"
              prerequisite="This journey has no steps stored."
              layout="inline"
            />
          ) : (
            <ul className="space-y-2">
              {tree.map((node) => (
                <StepBranch
                  key={node.step.id}
                  node={node}
                  depth={0}
                  onInspect={setOpenStep}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {citedUrls.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">
              Sources cited across this journey ({citedUrls.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="space-y-1 text-meta">
              {citedUrls.map((url) => (
                <li key={url}>
                  <SafeLink href={url} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">What these numbers are</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-2 text-table text-muted-foreground">
          <p>
            <strong>Mentioned</strong> and <strong>cited</strong> are booleans about whether the
            client appeared in an answer at all. <strong>Position</strong> is where the client&rsquo;s
            page sits inside an answer&rsquo;s own list of citations, when the answer listed one.
            These are not search positions and they are not the counted AEO rate: that rate is
            computed over all collected answers on the AI-visibility screens.
          </p>
          <p className="text-meta">
            Presence here is determined by matching the client&rsquo;s name and domain against the
            answer text and its citations. That is a derived reading of model output, not a
            measurement of it — the raw answer is always available above so the reading can be
            checked.
          </p>
        </CardContent>
      </Card>

      <EvidenceDrawer
        open={openStep !== null}
        onOpenChange={(open) => {
          if (!open) setOpenStep(null);
        }}
        title={openStep ? `Step answer — ${openStep.query}` : 'Step answer'}
        source={{
          name: `${journey.surface} surface`,
          capturedAt: openStep?.executedAt ?? journey.plannedAt,
          runId: journey.id,
          query: openStep?.query,
        }}
        observed={
          openStep ? (
            <ul className="space-y-1 text-table">
              <li>
                Mentioned the client: <strong>{openStep.mentioned ? 'yes' : 'no'}</strong>
              </li>
              <li>
                Cited the client: <strong>{openStep.cited ? 'yes' : 'no'}</strong>
                {openStep.citedUrl ? (
                  <>
                    {' '}
                    — <SafeLink href={openStep.citedUrl} />
                  </>
                ) : null}
              </li>
              <li>
                Position in the answer&rsquo;s citation list:{' '}
                <strong>{openStep.position ?? 'not listed'}</strong>
              </li>
              <li>
                Named competitors:{' '}
                <strong>
                  {(parseJsonColumn<string[]>(openStep.competitorsSeen, 'array') ?? []).join(', ') ||
                    'none'}
                </strong>
              </li>
            </ul>
          ) : null
        }
        interpretation={
          openStep
            ? 'Presence is decided by matching the client name and domain against the answer text and its citation URLs. A match is evidence that the name appeared, not evidence of what the answer claimed about it.'
            : undefined
        }
        interpretationKind="derived"
        raw={
          openStep?.answerText
            ? { label: 'Model answer, verbatim', text: openStep.answerText }
            : undefined
        }
        confidence={
          openStep
            ? {
                level: openStep.answerText ? 'high' : 'unknown',
                basis: openStep.answerText
                  ? `The full answer text was stored for this step (${openStep.model ?? 'model not recorded'}).`
                  : 'No answer text was stored for this step, so the presence reading cannot be checked.',
              }
            : undefined
        }
        provenance="model-interpretation"
        related={[{ label: 'This journey', href: `/projects/${projectId}/research/journeys/${journey.id}`, kind: 'run' }]}
      />

      <Dialog
        open={executeOpen}
        onOpenChange={(next) => {
          if (executing) return;
          setExecuteOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Execute journey</DialogTitle>
            <DialogDescription>
              Walks the {journey.stepCount - journey.executedSteps} pending step
              {journey.stepCount - journey.executedSteps === 1 ? '' : 's'} against the{' '}
              {journey.surface} surface and scores each answer for the client&rsquo;s and its
              competitors&rsquo; presence. This costs money when the surface is live.
            </DialogDescription>
          </DialogHeader>

          {actionError ? (
            <ErrorState error={actionError} layout="inline" providerName="the surface provider" />
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="jo2-cap">Cost cap for this run (USD)</Label>
            <Input
              id="jo2-cap"
              type="number"
              min={0}
              step="0.01"
              value={maxCostUsd}
              onChange={(event) => setMaxCostUsd(event.target.value)}
              placeholder="Leave blank to use the server's default run cap"
            />
            <p className="text-meta text-muted-foreground">
              The run stops the instant cumulative spend reaches this figure, and the remaining steps
              are marked skipped. Enter <strong>0</strong> to stop before any spend at all — useful
              to confirm the journey is wired up without paying for it.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExecuteOpen(false)} disabled={executing}>
              Cancel
            </Button>
            <Button onClick={() => void handleExecute()} disabled={executing}>
              {executing ? 'Executing…' : 'Execute journey'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete journey"
        confirmLabel="Delete journey"
        destructive
        targetLabel="Journey"
        target={journey.label}
        effect={
          <>
            The journey and all {journey.stepCount} of its steps — including every stored answer,
            citation and score — are deleted. It cannot be recovered from this screen.
          </>
        }
        scope={
          <>
            Only this journey is affected. Its campaign, other journeys and the client&rsquo;s site
            are unchanged.
          </>
        }
        onConfirm={handleDelete}
      />
    </div>
  );
}

/** Visual indentation per tree depth. Tokens only — no inline styles. */
const DEPTH_INDENT = ['', 'ml-4', 'ml-8', 'ml-12', 'ml-16', 'ml-20', 'ml-24'] as const;

interface StepNode {
  step: JourneyStep;
  children: StepNode[];
}

/** Roots first, children under their parent — the server orders by depth, then ordinal. */
function buildTree(steps: JourneyStep[]): StepNode[] {
  const nodes = new Map<string, StepNode>();
  for (const step of steps) nodes.set(step.id, { step, children: [] });
  const roots: StepNode[] = [];
  for (const step of steps) {
    const node = nodes.get(step.id);
    if (!node) continue;
    const parent = step.parentId ? nodes.get(step.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function StepBranch({
  node,
  depth,
  onInspect,
}: {
  node: StepNode;
  depth: number;
  onInspect: (step: JourneyStep) => void;
}) {
  const { step, children } = node;
  const competitors = parseJsonColumn<string[]>(step.competitorsSeen, 'array');
  const citations = parseJsonColumn<string[]>(step.citations, 'array');

  return (
    <li>
      <div className={cn('rounded-lg border border-border p-3', DEPTH_INDENT[depth] ?? DEPTH_INDENT[DEPTH_INDENT.length - 1])}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={stepStatusLabel(step.status)} tone={stepStatusTone(step.status)} />
          <span className="text-meta text-muted-foreground">
            depth {step.depth} · {step.kind} · {step.awareness}
          </span>
        </div>
        <p className="mt-2 text-table font-medium">{step.query}</p>
        <p className="text-meta text-muted-foreground">
          Planned because: {step.rationale}
        </p>

        {step.status === 'done' ? (
          <div className="mt-2 space-y-1 text-meta">
            <p>
              <span className="text-muted-foreground">Mentioned the client:</span>{' '}
              {step.mentioned ? 'yes' : 'no'} ·{' '}
              <span className="text-muted-foreground">cited:</span> {step.cited ? 'yes' : 'no'}
              {step.position !== null ? ` · at position ${step.position} in the answer` : ''}
            </p>
            {competitors === null ? (
              <p className="text-unmeasured-foreground">
                The competitor list stored for this step could not be read.
              </p>
            ) : competitors.length > 0 ? (
              <p>
                <span className="text-muted-foreground">Competitors named:</span>{' '}
                {competitors.join(', ')}
              </p>
            ) : (
              <p className="text-muted-foreground">No named competitor appeared in this answer.</p>
            )}
            <p className="text-muted-foreground">
              {step.model ?? 'Model not recorded'} · {step.latencyMs ?? 0} ms · $
              {step.costUsd.toFixed(4)}
              {step.executedAt ? (
                <>
                  {' · '}
                  <Timestamp value={step.executedAt} />
                </>
              ) : null}
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button variant="outline" size="sm" onClick={() => onInspect(step)}>
                Inspect the answer
              </Button>
              {citations && citations.length > 0 ? (
                <span className="text-meta text-muted-foreground">
                  {citations.length} source{citations.length === 1 ? '' : 's'} cited
                </span>
              ) : null}
            </div>
          </div>
        ) : step.status === 'failed' ? (
          <p className="mt-2 text-meta text-warning-foreground">
            The surface call for this step did not return an answer, so nothing was scored for it.
            See the journey&rsquo;s error above.
          </p>
        ) : step.status === 'skipped' ? (
          <p className="mt-2 text-meta text-muted-foreground">
            This step was skipped when execution stopped — most often the cost cap. It has no answer
            and contributes nothing to the scores above.
          </p>
        ) : (
          <p className="mt-2 text-meta text-muted-foreground">
            Not run yet. Executing the journey is what walks this step.
          </p>
        )}
      </div>

      {children.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {children.map((child) => (
            <StepBranch
              key={child.step.id}
              node={child}
              depth={depth + 1}
              onInspect={onInspect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SafeLink({ href }: { href: string }) {
  const isSafe = href.startsWith('/') || /^https?:\/\//i.test(href);
  if (!isSafe) {
    return <span className="evidence">{href} (not a link: unsupported URL scheme)</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all text-primary underline-offset-4 hover:underline"
    >
      <ExternalLink aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
      {href}
    </a>
  );
}

function stepStatusTone(status: string): StatusTone {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'warning';
    case 'skipped':
      return 'unmeasured';
    case 'pending':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function stepStatusLabel(status: string): string {
  switch (status) {
    case 'done':
      return 'Answered';
    case 'failed':
      return 'Call failed';
    case 'skipped':
      return 'Skipped';
    case 'pending':
      return 'Not run';
    default:
      return `Unrecognized: ${status}`;
  }
}

function journeyStatusTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    case 'planned':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function journeyStatusLabel(status: string): string {
  switch (status) {
    case 'planned':
      return 'Planned';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'partial':
      return 'Partial';
    case 'failed':
      return 'Failed';
    default:
      return `Unrecognized: ${status}`;
  }
}
