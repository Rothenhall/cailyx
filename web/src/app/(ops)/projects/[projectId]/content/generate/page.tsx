'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { RunConfigurator } from '@/components/patterns/RunConfigurator';
import { StatusPill, runStatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatCurrency, formatNumber, notMeasuredLabel } from '@/lib/format';
import type { RunEstimate, RunParameter } from '@/types';
import {
  ASSET_TYPE_LABELS,
  CONTENT_ASSET_TYPES,
  createContentBrief,
  createGenerationJob,
  estimateContentGeneration,
  isGeneratable,
  listContentBriefs,
  listGenerationJobs,
  listTopicSuggestions,
  retryGenerationJob,
  updateContentBrief,
  type ContentAssetType,
  type ContentBrief,
  type ContentCostEstimate,
  type GenerationJob,
  type TopicSuggestion,
} from '@/services/content';

/**
 * CT03 — Generate content.
 *
 * design_plan.md §4.4: *"Article/ad-copy type and top-topic count,
 * prerequisites, request count; result checklist."*
 *
 * §5.8 Stage C decides what this screen is allowed to promise: *"It does not
 * take arbitrary topic IDs, instructions, approved claims, a saved brief, or a
 * brand-voice ID. The generate screen must say 'Generate for the top N topics,'
 * preview those topics, and never imply exact selection controls are honored."*
 * So the topic control is a **count**, the preview shows exactly which topics
 * the server's current ranking will supply, and the copy says so.
 *
 * §10.4's scan/generation row is the acceptance criteria, and `RunConfigurator`
 * is the component that encodes it: prerequisites before the button, scope and
 * cost before the button, one explicit start, double-submit protection, and a
 * lost response that reconciles instead of retrying. **Nothing here generates
 * on load** — the reads are reads, and the one paid call happens on an explicit
 * press.
 *
 * §10.4's "cost shown in units that cannot be summed" rule survives the fact
 * that this build has no estimator for content generation: the server's
 * `available: false` and its reason are rendered verbatim, and the credits /
 * currency split is still honored for the day an estimator exists.
 */

const CONFIG_DEFAULTS = {
  briefId: '',
  assetType: 'article',
  topicCount: 3,
};

const GENERATABLE_OPTIONS = ['article', 'ad-copy'] as const;

export default function GenerateContentPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [topics, setTopics] = useState<TopicSuggestion[] | null>(null);
  const [briefs, setBriefs] = useState<ContentBrief[] | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[] | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [estimate, setEstimate] = useState<ContentCostEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<ReturnType<typeof toApiError> | null>(null);
  /** Bumped by the estimate panel's retry so the dry estimate can be re-fetched. */
  const [estimateNonce, setEstimateNonce] = useState(0);
  const [constraints, setConstraints] = useState('');
  const [result, setResult] = useState<GenerationJob | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [briefDialogOpen, setBriefDialogOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<ContentBrief | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [config, setConfig] = useUrlState(CONFIG_DEFAULTS);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        const [topicRows, briefRows, jobRows] = await Promise.all([
          listTopicSuggestions(projectId, { signal }),
          listContentBriefs(projectId, { latestOnly: true }, { signal }),
          listGenerationJobs(projectId, { limit: 20 }, { signal }),
        ]);
        setTopics(topicRows);
        setBriefs(briefRows.briefs);
        setJobs(jobRows.jobs);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const approvedBriefs = useMemo(
    () => (briefs ?? []).filter((brief) => brief.status === 'approved'),
    [briefs],
  );

  /**
   * The brief this batch will be bound to, and its **exact** version. The
   * version travels with the request: if the brief has moved since this screen
   * read it, the server rejects the batch rather than generating from
   * instructions nobody reviewed.
   */
  const selectedBrief = useMemo(() => {
    const wanted = config.briefId;
    if (wanted) {
      // A link can arrive from the library naming a version this list no longer
      // holds (a fork superseded it). Falling back to the newest approved brief
      // keeps the screen usable instead of failing a prerequisite against an id
      // the reader cannot see.
      const match = (briefs ?? []).find((brief) => brief.id === wanted);
      if (match) return match;
    }
    return approvedBriefs[0] ?? null;
  }, [approvedBriefs, briefs, config.briefId]);

  const assetType: 'article' | 'ad-copy' =
    config.assetType === 'ad-copy' ? 'ad-copy' : 'article';

  const topicCount = Math.max(1, Math.min(10, Number(config.topicCount) || 1));
  const topTopics = useMemo(() => (topics ?? []).slice(0, topicCount), [topics, topicCount]);

  /**
   * A dry, free pre-flight estimate. It is not a charge and not a reservation,
   * and the backend makes no provider call for it. The only estimator this
   * build has covers AEO sampling, so the honest answer for content generation
   * is `available: false` — rendered with the server's own reason.
   */
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        setEstimateError(null);
        const view = await estimateContentGeneration(
          projectId,
          { assetType, itemCount: topicCount },
          { signal: controller.signal },
        );
        if (!cancelled) setEstimate(view.estimate);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (!cancelled) setEstimateError(toApiError(caught));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId, assetType, topicCount, estimateNonce]);

  const runInFlight = (jobs ?? []).some(
    (job) => job.status === 'queued' || job.status === 'running',
  );

  async function onStart() {
    if (!selectedBrief) {
      throw new Error('Select an approved brief before generating.');
    }
    const job = await createGenerationJob(projectId, {
      briefId: selectedBrief.id,
      briefVersion: selectedBrief.version,
      assetType,
      items: topTopics.map((topic) => ({
        topicId: topic.targetKeyword,
        subject: topic.blogTopic,
      })),
      ...(constraints.trim() ? { constraints: constraints.trim() } : {}),
    });
    setResult(job);
    // Refresh the job ledger so `runInFlight` and the recent list reflect what
    // the server just recorded, rather than component memory (§10.3).
    void load();
  }

  async function onRetry(job: GenerationJob) {
    setRetrying(true);
    setRetryError(null);
    try {
      const updated = await retryGenerationJob(projectId, job.id);
      setResult(updated);
      void load();
    } catch (caught) {
      setRetryError(toApiError(caught));
    } finally {
      setRetrying(false);
    }
  }

  async function onApproveBrief(brief: ContentBrief) {
    setBriefBusy(true);
    setBriefError(null);
    try {
      const updated = await updateContentBrief(projectId, brief.id, { status: 'approved' });
      setApproveTarget(null);
      await load();
      setConfig({ briefId: updated.id }, { push: true });
    } catch (caught) {
      setBriefError(toApiError(caught));
    } finally {
      setBriefBusy(false);
    }
  }

  const parameters: RunParameter[] = [
    { key: 'assetType', label: 'Asset type', value: ASSET_TYPE_LABELS[assetType] },
    {
      key: 'brief',
      label: 'Brief',
      value: selectedBrief
        ? `${selectedBrief.title} · v${selectedBrief.version} (${selectedBrief.status})`
        : 'No brief selected',
    },
    { key: 'topics', label: 'Topics to generate for', value: `top ${topicCount}` },
    {
      key: 'language',
      label: 'Language',
      value: selectedBrief?.language ?? 'Not stated by the brief',
    },
  ];

  const prerequisites = [
    {
      label: 'An approved content brief',
      met: approvedBriefs.length > 0,
      detail:
        approvedBriefs.length > 0
          ? undefined
          : 'Generation is bound to an approved brief. Create one below, then approve it — an approved version is never rewritten by a later edit.',
    },
    {
      label: 'A brief version selected and reviewed',
      met: selectedBrief !== null && selectedBrief.status === 'approved',
      detail:
        selectedBrief === null
          ? 'Pick which approved brief this batch uses. The exact version shown is the one recorded on the job.'
          : selectedBrief.status !== 'approved'
            ? `The selected brief is "${selectedBrief.status}" at v${selectedBrief.version}. Only an approved version can be generated from.`
            : undefined,
    },
    {
      label: 'At least one priority topic to generate for',
      met: topTopics.length > 0,
      detail:
        topTopics.length > 0
          ? undefined
          : 'No keyword topic is available, so this batch would request zero items. A zero-topic job is valid but produces nothing.',
    },
    {
      label: 'A configured model provider',
      met: false,
      blocking: false as const,
      detail:
        'This build does not expose provider readiness here. If no provider is configured, the start fails with a 503 that names it, before anything is written.',
    },
  ];

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Generate content" />
        <ErrorState error={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  if (!topics || !briefs || !jobs) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Generate content"
        context="One artifact per selected topic, written from an approved brief and its exact recorded version."
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content`}>Asset library</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {/* ── Configuration ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">What to generate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <p className="text-table text-muted-foreground">
            Batch generation works from the server&rsquo;s current top-N priority topics. It does
            not accept a hand-picked list of topics, a free-form instruction set, or a brand-voice
            id — so this screen asks for a type and a count, and shows you exactly which topics that
            resolves to.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="brief-select">Approved brief</Label>
              <Select
                value={selectedBrief?.id ?? ''}
                onValueChange={(value) => setConfig({ briefId: value })}
              >
                <SelectTrigger id="brief-select">
                  <SelectValue placeholder="No approved brief" />
                </SelectTrigger>
                <SelectContent>
                  {approvedBriefs.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No approved brief yet
                    </SelectItem>
                  ) : (
                    approvedBriefs.map((brief) => (
                      <SelectItem key={brief.id} value={brief.id}>
                        {brief.title} · v{brief.version}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                The job records this brief&rsquo;s id and version, so a later edit cannot change
                what a re-run uses.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="asset-type">Asset type</Label>
              <Select
                value={assetType}
                onValueChange={(value) => setConfig({ assetType: value })}
              >
                <SelectTrigger id="asset-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENERATABLE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {ASSET_TYPE_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                Only {ASSET_TYPE_LABELS.article} and {ASSET_TYPE_LABELS['ad-copy']} can be
                generated. The other seven types stay brief-only.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="topic-count">Topics to generate for</Label>
              <Input
                id="topic-count"
                type="number"
                min={1}
                max={10}
                inputMode="numeric"
                value={topicCount}
                onChange={(event) =>
                  setConfig({ topicCount: Number(event.target.value) || 1 })
                }
              />
              <p className="text-meta text-muted-foreground">
                The server takes the top N of its own ranking — 1 to 10. It is a count, not a
                selection.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="constraints">Extra constraints (optional)</Label>
              <Textarea
                id="constraints"
                rows={2}
                value={constraints}
                onChange={(event) => setConstraints(event.target.value)}
                placeholder="e.g. avoid pricing claims; keep the tone practical"
              />
              <p className="text-meta text-muted-foreground">
                Appended to the generation instructions. Recorded on the job, not saved to the
                brief.
              </p>
            </div>
          </div>

          {selectedBrief && !isGeneratable(selectedBrief.assetType) ? (
            <Alert>
              <AlertTriangle aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>This brief&rsquo;s own type is brief-only</AlertTitle>
              <AlertDescription>
                “{selectedBrief.title}” is a {ASSET_TYPE_LABELS[selectedBrief.assetType]} brief.
                That type stays brief-only until separately implemented, so this batch will generate{' '}
                {ASSET_TYPE_LABELS[assetType]} from the same brief rather than implying the brief
                type itself is generated.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Briefs: create and approve ──────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Briefs</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setBriefDialogOpen(true)}>
            New brief
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {briefError ? (
            <ErrorState
              error={briefError}
              layout="inline"
              preserveNotice="No brief was changed by the failed attempt."
            />
          ) : null}

          {briefs.length === 0 ? (
            <p className="text-table text-muted-foreground">
              No brief exists yet. A brief is the instruction set: goal, audience, angle, target
              query, must-include points. Generation is bound to one, and to one exact version of
              it.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {briefs.map((brief) => (
                <li key={brief.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="text-table font-medium text-foreground">
                      {brief.title}
                      <span className="ml-2 text-meta text-muted-foreground">v{brief.version}</span>
                    </p>
                    <p className="text-meta text-muted-foreground">
                      {ASSET_TYPE_LABELS[brief.assetType]}
                      {brief.targetQuery ? ` · targets “${brief.targetQuery}”` : ''}
                      {brief.audience ? ` · ${brief.audience}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill
                      label={
                        brief.status === 'approved'
                          ? 'Approved'
                          : brief.status === 'draft'
                            ? 'Draft'
                            : 'Archived'
                      }
                      tone={
                        brief.status === 'approved'
                          ? 'success'
                          : brief.status === 'draft'
                            ? 'unmeasured'
                            : 'neutral'
                      }
                    />
                    {brief.status === 'draft' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setApproveTarget(brief)}
                        disabled={briefBusy}
                      >
                        Approve v{brief.version}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfig({ briefId: brief.id }, { push: true })}
                        disabled={brief.status !== 'approved'}
                      >
                        Use this brief
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── The run configuration and its one start action ───────────── */}
      <RunConfigurator
        startLabel={`Generate ${topicCount} ${ASSET_TYPE_LABELS[assetType]} draft${topicCount === 1 ? '' : 's'}`}
        prerequisites={prerequisites}
        parameters={parameters}
        runInFlight={runInFlight}
        scope={
          <div className="space-y-3">
            <dl className="grid gap-1 text-table sm:grid-cols-2">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Requests</dt>
                <dd className="font-medium text-foreground">
                  {formatNumber(topTopics.length)} item{topTopics.length === 1 ? '' : 's'} — one
                  model call each
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Artifacts expected</dt>
                <dd className="font-medium text-foreground">
                  {formatNumber(topTopics.length)}
                </dd>
              </div>
            </dl>

            {topTopics.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="priority keyword topics"
                prerequisite="a completed keyword-research run for this project"
              />
            ) : (
              <div className="space-y-1">
                <p className="text-table text-foreground">
                  These are the topics this batch will cover, in the server&rsquo;s ranking order:
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-table">
                  {topTopics.map((topic) => (
                    <li key={topic.targetKeyword}>
                      <span className="font-medium text-foreground">{topic.blogTopic}</span>
                      <span className="text-muted-foreground">
                        {' '}
                        — {topic.targetKeyword}
                        {topic.searchVolume === null
                          ? ` · search volume ${notMeasuredLabel()}`
                          : ` · ${formatNumber(topic.searchVolume)} searches`}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="text-meta text-muted-foreground">
                  A per-topic checklist is not offered: batch generation does not accept individual
                  topic ids, so this count is the only control that is actually honored.
                </p>
              </div>
            )}

            {estimateError ? (
              <ErrorState
                error={estimateError}
                layout="inline"
                onRetry={() => setEstimateNonce((current) => current + 1)}
                preserveNotice="The configuration above is unchanged."
              />
            ) : null}

            {estimate && !estimate.available ? (
              <div className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-table text-warning-foreground">
                <p className="font-medium">No pre-flight cost estimate exists for this run.</p>
                <p>
                  {estimate.reason ??
                    'The server returned no estimator for content generation.'}
                </p>
                <p className="mt-1">
                  Cost is recorded per item on the job when it finishes, in US dollars. Nothing is
                  reserved and nothing is charged by asking for an estimate.
                </p>
              </div>
            ) : null}

            {estimate && estimate.available && estimate.ranges.length > 0 ? (
              <ul className="space-y-1 text-meta text-muted-foreground">
                {estimate.ranges.map((range) => (
                  <li key={`${range.unit}-${range.basis}`}>
                    Server range: {formatNumber(range.low)}–{formatNumber(range.high)}{' '}
                    {range.unit === 'credits' ? 'credits' : range.unit.toUpperCase()} ·{' '}
                    {range.basisDetail}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        }
        configuration={[
          {
            label: 'Search Console / keyword source',
            availability: topics.length > 0 ? 'available' : 'unmapped',
            detail:
              topics.length > 0
                ? 'A completed keyword set supplied the topic ranking.'
                : 'No ranked keyword set exists, so no topic ranking can be supplied.',
          },
        ]}
        estimate={toRunEstimate(estimate)}
        onStart={onStart}
        onStarted={() => undefined}
        reconcileHref={`/projects/${projectId}/content/generate`}
      />

      {/* ── The result checklist ────────────────────────────────────── */}
      {result ? (
        <GenerationJobResult
          projectId={projectId}
          job={result}
          retrying={retrying}
          retryError={retryError}
          onRetry={() => void onRetry(result)}
        />
      ) : null}

      {/* ── Recent batches ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Recent generation batches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {jobs.length === 0 ? (
            <p className="text-table text-muted-foreground">
              No batch has run for this project yet. Starting one records a job with per-item
              results — a short batch is visible as a short batch, never as a clean success.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {jobs.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="text-table text-foreground">
                      {ASSET_TYPE_LABELS[job.assetType]} ·{' '}
                      {job.requested} requested, {job.succeeded} succeeded, {job.failed} failed
                    </p>
                    <p className="text-meta text-muted-foreground">
                      <Timestamp value={job.createdAt} />
                      {job.briefVersion !== null ? ` · brief v${job.briefVersion}` : ''}
                      {job.model ? ` · ${job.model}` : ''}
                      {job.costUsd > 0 ? ` · ${formatCurrency(job.costUsd, 'USD')} recorded` : ''}
                    </p>
                    {job.note ? (
                      <p className="text-meta text-muted-foreground">{job.note}</p>
                    ) : null}
                  </div>
                  <StatusPill label={jobStatusLabel(job.status)} tone={runStatusTone(job.status)} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
        title="Approve this brief version?"
        confirmLabel={`Approve v${approveTarget?.version ?? ''}`}
        targetLabel="Brief"
        target={
          approveTarget
            ? `${approveTarget.title} · v${approveTarget.version}`
            : 'No brief selected'
        }
        effect={
          <>
            Generation becomes possible from this exact version. A later content edit will not
            rewrite it — it forks a new draft version instead, so a job that already recorded this
            version keeps pointing at the instructions it actually used. This is an internal marker
            on the instruction set, not client-facing approval.
          </>
        }
        onConfirm={() => (approveTarget ? onApproveBrief(approveTarget) : undefined)}
        onConfirmed={() => setApproveTarget(null)}
      />

      <NewBriefDialog
        open={briefDialogOpen}
        onOpenChange={setBriefDialogOpen}
        busy={briefBusy}
        error={briefError}
        onCreate={async (input) => {
          setBriefBusy(true);
          setBriefError(null);
          try {
            const created = await createContentBrief(projectId, input);
            setBriefDialogOpen(false);
            await load();
            setConfig({ briefId: created.id }, { push: true });
          } catch (caught) {
            setBriefError(toApiError(caught));
          } finally {
            setBriefBusy(false);
          }
        }}
      />
    </div>
  );
}

// ── Result checklist ────────────────────────────────────────────────────

function GenerationJobResult({
  projectId,
  job,
  retrying,
  retryError,
  onRetry,
}: {
  projectId: string;
  job: GenerationJob;
  retrying: boolean;
  retryError: ReturnType<typeof toApiError> | null;
  onRetry: () => void;
}) {
  const zeroRequested = job.requested === 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-subsection">Batch result</CardTitle>
          <p className="text-meta text-muted-foreground">
            Started <Timestamp value={job.createdAt} />
            {job.model ? ` · ${job.model}` : ''}
          </p>
        </div>
        <StatusPill label={jobStatusLabel(job.status)} tone={runStatusTone(job.status)} />
      </CardHeader>
      <CardContent className="space-y-4 pt-2">
        {/*
          The two ways this list can be short are different outcomes, and §5.8
          Stage C is explicit that they must not be collapsed: "A zero-item
          request is valid and records a completed job with requested 0,
          distinct from a batch whose items each failed."
        */}
        {zeroRequested ? (
          <Alert>
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Nothing was requested</AlertTitle>
            <AlertDescription>
              {job.note ??
                'No topics were selected, so no artifact was asked for and none failed. This is a zero-item batch, not a generation failure.'}
            </AlertDescription>
          </Alert>
        ) : job.failed > 0 ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>
              {job.failed} of {job.requested} item{job.requested === 1 ? '' : 's'} failed
            </AlertTitle>
            <AlertDescription>
              {job.succeeded > 0
                ? `${job.succeeded} item${job.succeeded === 1 ? '' : 's'} did succeed and ${
                    job.succeeded === 1 ? 'is' : 'are'
                  } saved as draft${job.succeeded === 1 ? '' : 's'} — a partial batch is never reported as a clean success.`
                : 'No item succeeded. The per-item errors below are the actual reasons.'}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>
              {job.succeeded} of {job.requested} item
              {job.requested === 1 ? '' : 's'} generated
            </AlertTitle>
            <AlertDescription>
              Each artifact is saved as a draft at revision 1, bound to brief v{job.briefVersion}.
            </AlertDescription>
          </Alert>
        )}

        <dl className="grid grid-cols-3 gap-x-6 gap-y-2 text-table">
          <div>
            <dt className="text-meta text-muted-foreground">Requested</dt>
            <dd className="tabular-nums">{formatNumber(job.requested)}</dd>
          </div>
          <div>
            <dt className="text-meta text-muted-foreground">Succeeded</dt>
            <dd className="tabular-nums">{formatNumber(job.succeeded)}</dd>
          </div>
          <div>
            <dt className="text-meta text-muted-foreground">Failed</dt>
            <dd className="tabular-nums">{formatNumber(job.failed)}</dd>
          </div>
        </dl>

        <div className="text-table">
          <p className="text-meta text-muted-foreground">Recorded provider cost (USD)</p>
          <p className="font-medium text-foreground">
            {/* Money only, in its own unit — never added to a credit figure. */}
            {job.costUsd > 0 ? formatCurrency(job.costUsd, 'USD') : 'No cost recorded on this job'}
          </p>
        </div>

        {job.items.length > 0 ? (
          <ul className="divide-y divide-border">
            {job.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="text-table font-medium text-foreground">
                    {item.subject ?? item.topicId ?? 'Untitled topic'}
                  </p>
                  {item.error ? (
                    <p className="text-meta text-danger-foreground">{item.error}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  {item.assetId ? (
                    <Link
                      href={`/projects/${projectId}/content/${item.assetId}`}
                      className="text-table text-primary underline-offset-4 hover:underline"
                    >
                      Open draft
                    </Link>
                  ) : null}
                  <StatusPill label={itemStatusLabel(item.status)} tone={itemStatusTone(item.status)} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {retryError ? (
          <ErrorState
            error={retryError}
            layout="inline"
            preserveNotice="The successful items are untouched — a retry never re-runs or re-charges them."
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={job.retryableItemIds.length === 0 || retrying}
            onClick={onRetry}
          >
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Retry {job.retryableItemIds.length} failed item
            {job.retryableItemIds.length === 1 ? '' : 's'}
          </Button>
          <span className="text-meta text-muted-foreground">
            {job.retryableItemIds.length === 0
              ? 'No failed item on this batch can be retried.'
              : 'Retries the exact brief version this batch recorded. Succeeded items are never re-run or re-charged.'}
          </span>
        </div>

        <Button asChild variant="link" size="sm" className="px-0">
          <Link href={`/projects/${projectId}/content`}>Open the asset library</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ── New brief ───────────────────────────────────────────────────────────

function NewBriefDialog({
  open,
  onOpenChange,
  busy,
  error,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: ReturnType<typeof toApiError> | null;
  onCreate: (input: {
    title: string;
    assetType: ContentAssetType;
    targetQuery?: string;
    audience?: string;
    intent?: 'informational' | 'commercial' | 'transactional' | 'navigational';
    angle?: string;
    mustInclude?: string[];
    wordTarget?: number;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [assetType, setAssetType] = useState<ContentAssetType>('article');
  const [targetQuery, setTargetQuery] = useState('');
  const [audience, setAudience] = useState('');
  const [intent, setIntent] = useState<'informational' | 'commercial' | 'transactional' | 'navigational'>(
    'informational',
  );
  const [angle, setAngle] = useState('');
  const [mustInclude, setMustInclude] = useState('');
  const [wordTarget, setWordTarget] = useState('1200');
  // §10.4's double-submit rule: a ref guard, because two clicks in the same
  // tick both see the same state.
  const submitting = useRef(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const wordTargetNumber = Number(wordTarget);
  const wordTargetValid =
    wordTarget === '' || (Number.isFinite(wordTargetNumber) && wordTargetNumber >= 50);

  async function submit() {
    if (submitting.current || busy) return;
    if (title.trim().length < 3) {
      setTitleError('A brief needs a title of at least 3 characters.');
      return;
    }
    setTitleError(null);
    submitting.current = true;
    try {
      await onCreate({
        title: title.trim(),
        assetType,
        ...(targetQuery.trim() ? { targetQuery: targetQuery.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        intent,
        ...(angle.trim() ? { angle: angle.trim() } : {}),
        ...(mustInclude.trim()
          ? {
              mustInclude: mustInclude
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            }
          : {}),
        ...(wordTarget !== '' && wordTargetValid ? { wordTarget: wordTargetNumber } : {}),
      });
    } finally {
      submitting.current = false;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New content brief</DialogTitle>
          <DialogDescription>
            The instruction set generation is bound to. It is created as a draft at version 1; approve
            it before generating. Seven of the nine asset types can be briefed here but not
            generated — the brief is still the deliverable for a human writer.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState
            error={error}
            layout="inline"
            fieldIdPrefix="brief-"
            preserveNotice="Nothing you typed has been lost."
          />
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="brief-title">Title (required)</Label>
            <Input
              id="brief-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={titleError !== null}
              aria-describedby={titleError ? 'brief-title-error' : undefined}
            />
            {titleError ? (
              <p id="brief-title-error" className="text-meta text-danger-foreground">
                {titleError}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="brief-asset-type">Asset type</Label>
            <Select
              value={assetType}
              onValueChange={(value) => setAssetType(value as ContentAssetType)}
            >
              <SelectTrigger id="brief-asset-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_ASSET_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {ASSET_TYPE_LABELS[type]}
                    {isGeneratable(type) ? '' : ' (brief only)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="brief-intent">Intent</Label>
            <Select
              value={intent}
              onValueChange={(value) =>
                setIntent(
                  value as 'informational' | 'commercial' | 'transactional' | 'navigational',
                )
              }
            >
              <SelectTrigger id="brief-intent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="informational">Informational</SelectItem>
                <SelectItem value="commercial">Commercial</SelectItem>
                <SelectItem value="transactional">Transactional</SelectItem>
                <SelectItem value="navigational">Navigational</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="brief-target-query">Primary target query</Label>
            <Input
              id="brief-target-query"
              value={targetQuery}
              onChange={(event) => setTargetQuery(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="brief-audience">Audience / persona</Label>
            <Input
              id="brief-audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="brief-angle">Angle / key message</Label>
            <Input
              id="brief-angle"
              value={angle}
              onChange={(event) => setAngle(event.target.value)}
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="brief-must-include">Must-include points (one per line)</Label>
            <Textarea
              id="brief-must-include"
              rows={3}
              value={mustInclude}
              onChange={(event) => setMustInclude(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="brief-word-target">Word target</Label>
            <Input
              id="brief-word-target"
              type="number"
              min={50}
              inputMode="numeric"
              value={wordTarget}
              onChange={(event) => setWordTarget(event.target.value)}
              aria-invalid={!wordTargetValid}
              aria-describedby="brief-word-target-help"
            />
            <p id="brief-word-target-help" className="text-meta text-muted-foreground">
              {wordTargetValid
                ? 'Minimum 50. Leave empty for no target.'
                : 'A word target must be 50 or more, or left empty.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} aria-busy={busy}>
            {busy ? 'Creating…' : 'Create draft brief'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Small maps ──────────────────────────────────────────────────────────

function jobStatusLabel(status: GenerationJob['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'partial':
      return 'Partial';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
  }
}

function itemStatusTone(status: GenerationJob['items'][number]['status']) {
  switch (status) {
    case 'succeeded':
      return 'success' as const;
    case 'failed':
      return 'danger' as const;
    case 'pending':
      return 'unmeasured' as const;
    case 'skipped':
      return 'neutral' as const;
  }
}

function itemStatusLabel(status: GenerationJob['items'][number]['status']): string {
  switch (status) {
    case 'succeeded':
      return 'Generated';
    case 'failed':
      return 'Failed';
    case 'pending':
      return 'Not started';
    case 'skipped':
      return 'Skipped';
  }
}

/**
 * Credits and money are mapped to their **own** fields, so the shared
 * `RunEstimateSummary` renders them as two rows that cannot be added together.
 * An estimate with no ranges at all returns `undefined`, which the component
 * reports as "no estimate" rather than as a cost of zero.
 */
function toRunEstimate(estimate: ContentCostEstimate | null): RunEstimate | undefined {
  if (!estimate || !estimate.available || estimate.ranges.length === 0) return undefined;
  const credits = estimate.ranges.find((range) => range.unit === 'credits');
  const usd = estimate.ranges.find((range) => range.unit === 'usd');
  const mapped: RunEstimate = {};
  if (credits) mapped.costCredits = credits.high;
  if (usd) {
    mapped.costCurrency = usd.high;
    mapped.currencyCode = 'USD';
  }
  return mapped;
}
