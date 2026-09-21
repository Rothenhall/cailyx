'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber } from '@/lib/format';
import {
  GAP_ACTION_LABEL,
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_LABELS,
  ROADMAP_HORIZONS,
  buildActionPlan,
  getActionPlan,
  getGapRoadmap,
  listGaps,
  resolveRecommendationGaps,
  type ActionPlan,
  type Gap,
  type GapAction,
  type Roadmap,
} from '@/services/planning';
import {
  assignToPhase,
  getStaffActions,
  listCommitments,
  listCycles,
  listMilestones,
  listPhases,
  listWorkItems,
  removeFromPhase,
  type ActionItem,
  type Commitment,
  type CommitmentStatus,
  type Cycle,
  type Milestone,
  type Phase,
  type WorkItem,
} from '@/services/delivery-plan';

/** §6.2's areas of work. Only the ones a project actually uses are rendered. */
const WORKSTREAM_LABEL: Record<string, string> = {
  website: 'Website',
  content: 'Content',
  email: 'Email',
  ads: 'Ads',
  'online-presence': 'Online presence',
  other: 'Other agreed work',
};

/**
 * One commitment in the staff view.
 *
 * `progress.label` is rendered exactly as the server derived it ("3 of 10
 * articles published"), never recomputed into a percentage here — the number
 * a client will hold the team to must come from one place. The staff-only
 * expansion is the linked execution tasks, which the client view omits.
 */
function CommitmentRow({
  commitment,
  projectId,
  workItems,
  phases,
  onPhaseChange,
  phaseAssigning,
}: {
  commitment: Commitment;
  projectId: string;
  workItems: WorkItem[];
  phases: Phase[];
  onPhaseChange: (commitmentId: string, phaseId: string) => void;
  phaseAssigning: boolean;
}) {
  const { progress } = commitment;
  const showBar = progress.kind === 'countable' && progress.targetCount != null && progress.targetCount > 0;
  const percent = showBar
    ? Math.min(100, Math.round((progress.verifiedCount / (progress.targetCount ?? 1)) * 100))
    : 0;
  const linked = commitment.linkedWorkItemIds
    .map((id) => workItems.find((item) => item.id === id))
    .filter((item): item is WorkItem => item !== undefined);
  const missing = commitment.linkedWorkItemIds.length - linked.length;

  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-table font-medium">{commitment.title}</p>
          {commitment.reason ? (
            <p className="text-meta text-muted-foreground">{commitment.reason}</p>
          ) : null}
        </div>
        <StatusPill
          label={commitmentStatusLabel(commitment.status)}
          tone={commitmentStatusTone(commitment.status)}
        />
      </div>

      <p className="text-table font-medium">{progress.label}</p>
      {showBar ? <Progress value={percent} aria-label={progress.label} /> : null}

      {phases.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-meta text-muted-foreground">Phase</span>
          <Select
            value={commitment.phaseId ?? '__none__'}
            onValueChange={(value) => onPhaseChange(commitment.id, value)}
            disabled={phaseAssigning}
          >
            <SelectTrigger className="h-7 w-40 text-meta">
              <SelectValue placeholder="Unphased" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Unphased</SelectItem>
              {phases.map((phase) => (
                <SelectItem key={phase.id} value={phase.id}>
                  {phase.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
        {commitment.targetDate ? (
          <span>
            Target <Timestamp value={commitment.targetDate} dateOnly />
          </span>
        ) : null}
        {commitment.agreedAt ? (
          <span>
            Agreed <Timestamp value={commitment.agreedAt} dateOnly />
          </span>
        ) : (
          // §6.3: an operator writing the plan is not client agreement, so an
          // unagreed commitment says so rather than looking settled.
          <span>Not yet agreed with the client</span>
        )}
        {commitment.accountableLead ? (
          <span>{commitment.clientVisibleLead ? 'Lead shown to client' : 'Lead hidden from client'}</span>
        ) : null}
      </div>

      {linked.length > 0 || missing > 0 ? (
        <details className="text-meta">
          <summary className="cursor-pointer text-muted-foreground">
            {linked.length} linked task{linked.length === 1 ? '' : 's'}
            {missing > 0 ? ` · ${missing} no longer present` : ''}
          </summary>
          <ul className="mt-1 space-y-1 pl-4">
            {linked.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/projects/${projectId}/work/${item.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {item.title}
                </Link>
                <span className="text-muted-foreground"> · {item.status}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {commitment.scopeChanges.length > 0 ? (
        <details className="text-meta">
          <summary className="cursor-pointer text-muted-foreground">
            {commitment.scopeChanges.length} scope change
            {commitment.scopeChanges.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-1 pl-4">
            {commitment.scopeChanges.map((change, index) => (
              <li key={`${change.at}-${index}`} className="text-muted-foreground">
                <Timestamp value={change.at} dateOnly /> — {change.reason}
                {change.newTarget != null ? ` (target → ${formatNumber(change.newTarget)})` : ''}
                {change.requiresReconfirmation ? ' · needs client reconfirmation' : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {commitment.cancelReason ? (
        <p className="text-meta text-muted-foreground">Cancelled: {commitment.cancelReason}</p>
      ) : null}
    </li>
  );
}

function commitmentStatusLabel(status: CommitmentStatus): string {
  switch (status) {
    case 'active':
      return 'In progress';
    case 'needs-attention':
      return 'Needs attention';
    case 'agreed':
      return 'Agreed';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function commitmentStatusTone(status: CommitmentStatus): StatusTone {
  switch (status) {
    case 'completed':
    case 'closed':
      return 'success';
    case 'needs-attention':
      return 'warning';
    case 'cancelled':
    case 'superseded':
      return 'neutral';
    case 'active':
    case 'agreed':
      return 'info';
    default:
      return 'unmeasured';
  }
}

/**
 * PJ07 — Roadmap.
 *
 * design_plan.md §4.3: *"Fix/build/influence, recommendation categories,
 * ordered work, 30/60/90-day proposal"*, support "E ranked recommendations;
 * **dated commitments G06**".
 *
 * The support column is the line this screen holds. A **ranked** plan exists:
 * the strategy layer orders recommendations by `priorityRank` across the whole
 * plan, and groups gaps by fix/build/influence. A **dated** plan does not —
 * nothing in the strategy output carries a date, and §11.1 keeps dated
 * commitments behind G06. So:
 *
 *  - The ranking is shown as the ranking, with each recommendation resolved
 *    against the live gap list by id. (The plan stores *pointers* to gaps, not
 *    copies of their text, so resolving is the only correct way to render it —
 *    reading a cached summary would show yesterday's evidence.)
 *  - The 30/60/90 view contains **only what is genuinely dated**: cycles (which
 *    are time-boxed by definition), milestones, and work items with a due date.
 *    It is a proposal because those are proposals until a cycle is committed —
 *    and committing is what freezes it, not this screen.
 *  - A category in `notCovered` is shown as having **no evidence behind it**,
 *    naming the reason. That is §3.5's "not measured yet" case: it is not a
 *    category with zero work in it.
 */
export default function RoadmapPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [phaseAssigningId, setPhaseAssigningId] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [building, setBuilding] = useState(false);
  const [buildNotice, setBuildNotice] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);

  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // "Today" is resolved after mount so the horizons cannot disagree between
    // the server render and the client render.
    setNow(Date.now());
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [
        planResult,
        roadmapResult,
        gapResult,
        cycleResult,
        milestoneResult,
        workResult,
        commitmentResult,
        actionResult,
        phaseResult,
      ] = await Promise.all([
        getActionPlan(projectId, { signal }),
        getGapRoadmap(projectId, { signal }),
        listGaps(projectId, undefined, { signal }),
        listCycles(projectId, undefined, { signal }).catch(() => []),
        listMilestones(projectId, { signal }).catch(() => []),
        listWorkItems(projectId, undefined, { signal }).catch(() => []),
        // §6.2's dated commitments and §5.6's action queue are their own
        // reads. They are allowed to fail independently: a project with no
        // commitments yet, or a caller who may not see the queue, must still
        // get the ranked plan rather than a blank page.
        listCommitments(projectId, undefined, { signal }).catch(() => []),
        getStaffActions(projectId, { signal }).catch(() => ({ items: [], total: 0 })),
        // C3, Option B — optional; most projects have none yet.
        listPhases(projectId, { signal }).catch(() => []),
      ]);
      setPlan(planResult);
      setRoadmap(roadmapResult);
      setGaps(gapResult.gaps);
      setCycles(cycleResult);
      setMilestones(milestoneResult);
      setWorkItems(workResult);
      setCommitments(commitmentResult);
      setActions(actionResult.items);
      setPhases(phaseResult);
    },
    [projectId],
  );

  async function onCommitmentPhaseChange(commitmentId: string, phaseId: string) {
    setPhaseAssigningId(commitmentId);
    try {
      if (phaseId === '__none__') {
        await removeFromPhase(projectId, { commitmentId });
      } else {
        await assignToPhase(projectId, phaseId, { commitmentId });
      }
      await load();
    } finally {
      setPhaseAssigningId(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setError(null);
        setLoading(true);
        await load(controller.signal);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [load]);

  async function onBuild() {
    if (building) return;
    setBuilding(true);
    setBuildNotice(null);
    setBuildError(null);
    try {
      const built = await buildActionPlan(projectId);
      setPlan(built);
      setBuildNotice(
        `Plan rebuilt: ${formatNumber(built.recommendations.length)} recommendation${
          built.recommendations.length === 1 ? '' : 's'
        } across ${formatNumber(RECOMMENDATION_CATEGORIES.length - built.notCovered.length)} categor${
          RECOMMENDATION_CATEGORIES.length - built.notCovered.length === 1 ? 'y' : 'ies'
        }.`,
      );
      await load();
    } catch (caught) {
      setBuildError(toApiError(caught).message);
    } finally {
      setBuilding(false);
    }
  }

  const ordered = useMemo(
    () => [...(plan?.recommendations ?? [])].sort((a, b) => a.priorityRank - b.priorityRank),
    [plan],
  );

  /** What each horizon genuinely contains: dated commitments, nothing inferred. */
  const horizons = useMemo(() => {
    if (now === null) return [];
    const day = 86_400_000;
    return ROADMAP_HORIZONS.map((horizon) => {
      const from = now + horizon.fromDay * day;
      const to = now + horizon.toDay * day;

      const items = workItems.filter((item) => {
        if (!item.dueAt) return false;
        const at = new Date(item.dueAt).getTime();
        return at >= from && at < to;
      });
      const due = milestones.filter((milestone) => {
        if (!milestone.dueAt) return false;
        const at = new Date(milestone.dueAt).getTime();
        return at >= from && at < to;
      });
      // A cycle overlaps the window rather than falling inside it — a
      // two-week cycle straddling the boundary belongs to both.
      const overlapping = cycles.filter((cycle) => {
        const start = new Date(cycle.startsOn).getTime();
        const end = new Date(cycle.endsOn).getTime();
        return start < to && end >= from;
      });

      return { horizon, items, milestones: due, cycles: overlapping };
    });
  }, [now, workItems, milestones, cycles]);

  /**
   * §6.2: commitments are grouped by area of work, and **a section appears
   * only when the project actually has work in it** — "avoid empty workstream
   * tabs for services the client has not purchased or approved". So the
   * grouping is built from the commitments that exist rather than from the
   * full list of possible workstreams.
   *
   * Closed and cancelled commitments are kept in the list but sorted last:
   * §6.3 requires that completed work is never silently removed to make
   * progress look better.
   */
  const commitmentGroups = useMemo(() => {
    const order: string[] = [];
    const byWorkstream = new Map<string, Commitment[]>();
    for (const commitment of commitments) {
      const key = commitment.workstream || 'other';
      if (!byWorkstream.has(key)) {
        byWorkstream.set(key, []);
        order.push(key);
      }
      byWorkstream.get(key)?.push(commitment);
    }
    const settled = new Set<CommitmentStatus>(['completed', 'closed', 'cancelled', 'superseded']);
    return order.map((workstream) => ({
      workstream,
      commitments: [...(byWorkstream.get(workstream) ?? [])].sort((a, b) => {
        const aSettled = settled.has(a.status) ? 1 : 0;
        const bSettled = settled.has(b.status) ? 1 : 0;
        if (aSettled !== bSettled) return aSettled - bSettled;
        return a.title.localeCompare(b.title);
      }),
    }));
  }, [commitments]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Project', href: `/projects/${projectId}` }]}
          title="Roadmap"
        />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  const roadmapTotal = roadmap?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Roadmap' },
        ]}
        title="Roadmap"
        context="Ranked recommendations drawn from classified findings, and what is actually dated."
        status={<ProvenanceBadge kind="derived" label="Derived from classified findings" />}
        primaryAction={{
          label: building ? 'Rebuilding…' : plan ? 'Rebuild the plan' : 'Build the plan',
          onClick: () => void onBuild(),
          disabled: building,
          disabledReason: building ? 'A build is already in flight.' : undefined,
        }}
      />

      <p className="text-table text-muted-foreground">
        Building re-classifies findings from stored evidence first, then regroups them. It is
        read-only against the outside world — no scan, crawl or paid call — and it preserves axes an
        operator has overridden.
      </p>

      {buildNotice ? (
        <Alert>
          <AlertDescription>{buildNotice}</AlertDescription>
        </Alert>
      ) : null}

      {buildError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Rebuild failed</AlertTitle>
          <AlertDescription>{buildError}</AlertDescription>
        </Alert>
      ) : null}

      {/* ── Needs your attention (staff queue, §5.6) ────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Needs your attention</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-table text-muted-foreground">
            Work assigned to you or waiting on the team, derived from the approvals, requests and
            work items that actually hold it — not a separate to-do list. An item leaves this list
            when its source is resolved, not when it is opened.
          </p>
          {actions.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="items waiting on the team"
              prerequisite="an assigned approval, request or review task"
              layout="inline"
            >
              <p>
                Nothing is waiting on you or on the team right now. Audit findings are deliberately
                absent here — they live on Priorities as evidence, and only become an action when
                somebody asks you to supply or approve something.
              </p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {actions.map((item) => (
                <li key={`${item.sourceType}:${item.sourceId}`} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-table font-medium">{item.title}</span>
                      <StatusPill
                        tone={item.severity === 'overdue' ? 'danger' : item.severity === 'blocking' ? 'warning' : 'neutral'}
                        label={item.severity === 'overdue' ? 'Overdue' : item.severity === 'blocking' ? 'Blocking' : 'Requested'}
                      />
                    </div>
                    <p className="text-table text-muted-foreground">{item.reason}</p>
                    <p className="text-meta text-muted-foreground">
                      Completes when {item.completionCondition}
                      {item.deadline ? (
                        <>
                          {' · '}due <Timestamp value={item.deadline} dateOnly />
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={item.destination}>Open</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── 30-day plan commitments (§6.1-6.3) ──────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">30-day plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            What we intend to accomplish in this period, grouped by area of work. A commitment is
            not a task: its progress counts verified deliverables against a target that is frozen
            when the scope is agreed, and an outcome goal is never completed just because its tasks
            closed. This is the staff view — the client sees the same commitments without the
            execution detail.
          </p>

          {commitments.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="plan commitments"
              prerequisite="a cycle to attach them to"
              action={{ label: 'Open the cycle board', href: `/projects/${projectId}/cycles` }}
              layout="inline"
            >
              <p>
                No commitment has been written for this project yet. The ranked plan below is a
                ranking, not a promise — a commitment is what carries a target and a date, and it is
                created deliberately.
              </p>
            </EmptyState>
          ) : (
            <div className="space-y-5">
              {commitmentGroups.map((group) => (
                <section key={group.workstream} className="space-y-2">
                  <h3 className="text-table font-medium">
                    {WORKSTREAM_LABEL[group.workstream] ?? group.workstream}
                  </h3>
                  <ul className="space-y-2">
                    {group.commitments.map((commitment) => (
                      <CommitmentRow
                        key={commitment.id}
                        commitment={commitment}
                        projectId={projectId}
                        workItems={workItems}
                        phases={phases}
                        onPhaseChange={(id, phaseId) => void onCommitmentPhaseChange(id, phaseId)}
                        phaseAssigning={phaseAssigningId === commitment.id}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Fix / build / influence ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Fix, build, influence</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {roadmapTotal === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="findings grouped by the response they call for"
              prerequisite="classified findings (see Priorities)"
              action={{ label: 'Open priorities', href: `/projects/${projectId}/priorities` }}
              layout="inline"
            >
              <p>
                No finding has been classified yet, so there is nothing to group. This is not an
                empty roadmap — it is a roadmap with no classified evidence underneath it.
              </p>
            </EmptyState>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              {(roadmap?.groups ?? []).map((group) => (
                <div key={group.action} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-table font-medium">
                      {GAP_ACTION_LABEL[group.action as GapAction] ?? group.action}
                    </h3>
                    <span className="text-meta text-muted-foreground">
                      {formatNumber(group.count)}
                    </span>
                  </div>
                  {group.gaps.length === 0 ? (
                    <p className="text-meta text-muted-foreground">
                      Nothing classified into this response.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {group.gaps.slice(0, 8).map((gap) => (
                        <li key={gap.id}>
                          <Link
                            href={`/projects/${projectId}/priorities/${gap.id}`}
                            className="block truncate text-table underline-offset-4 hover:underline"
                            title={gap.title}
                          >
                            {gap.title}
                          </Link>
                        </li>
                      ))}
                      {group.gaps.length > 8 ? (
                        <li className="text-meta text-muted-foreground">
                          and {formatNumber(group.gaps.length - 8)} more
                        </li>
                      ) : null}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Ranked recommendations ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Ordered work — the ranked plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!plan ? (
            <EmptyState
              variant="not-measured"
              subject="a built action plan"
              prerequisite="building the plan from classified findings"
              action={{ label: 'Build the plan', onClick: () => void onBuild() }}
              layout="inline"
            >
              <p>
                No action plan has been built for this project yet. The ranked order comes from the
                plan, so there is nothing to show until one exists — the findings themselves are on
                the Priorities screen.
              </p>
            </EmptyState>
          ) : ordered.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="recommendations in the plan"
              prerequisite="classified findings that call for action"
              layout="inline"
            >
              <p>
                The plan exists and contains no recommendations, because no classified finding
                called for action. Strengths never produce one by design.
              </p>
            </EmptyState>
          ) : (
            <ol className="divide-y divide-border">
              {ordered.map((recommendation) => {
                const linked = resolveRecommendationGaps(recommendation, gaps);
                const unresolvable = recommendation.gapIds.length - linked.length;
                return (
                  <li key={recommendation.id} className="space-y-2 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-meta tabular-nums text-muted-foreground">
                            #{formatNumber(recommendation.priorityRank)}
                          </span>
                          <span className="text-table font-medium">{recommendation.title}</span>
                        </div>
                        <p className="text-table text-muted-foreground">{recommendation.summary}</p>
                      </div>
                      <StatusPill
                        tone="neutral"
                        label={
                          RECOMMENDATION_LABELS[recommendation.category] ?? recommendation.category
                        }
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground">
                      <span>Quick wins {formatNumber(recommendation.quickWinCount)}</span>
                      <span>Major projects {formatNumber(recommendation.majorProjectCount)}</span>
                      <span>Fill-ins {formatNumber(recommendation.fillInCount)}</span>
                      <span>Thankless tasks {formatNumber(recommendation.thanklessTaskCount)}</span>
                    </div>

                    {linked.length > 0 ? (
                      <ul className="flex flex-wrap gap-x-4 gap-y-1">
                        {linked.map((gap) => (
                          <li key={gap.id}>
                            <Link
                              href={`/projects/${projectId}/priorities/${gap.id}`}
                              className="text-table underline-offset-4 hover:underline"
                            >
                              {gap.title}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {unresolvable > 0 ? (
                      // The plan stores gap ids, so a gap that no longer exists
                      // is a real divergence worth naming rather than hiding.
                      <p className="text-meta text-warning-foreground">
                        {formatNumber(unresolvable)} finding{unresolvable === 1 ? '' : 's'} bundled
                        here {unresolvable === 1 ? 'is' : 'are'} no longer present in the classified
                        list. Rebuilding the plan reconciles it.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* ── Recommendation categories ───────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Recommendation categories</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-table text-muted-foreground">
            Nine categories. A category with no recommendation has no evidence behind it — that is
            stated below rather than shown as a category with nothing to do.
          </p>
          <ul className="grid gap-2 sm:grid-cols-3">
            {RECOMMENDATION_CATEGORIES.map((category) => {
              const recommendation = ordered.find((row) => row.category === category);
              const notCovered = plan?.notCovered.includes(category) ?? false;
              return (
                <li
                  key={category}
                  className="space-y-1 rounded-md border border-border bg-surface-sunken p-3"
                >
                  <p className="text-table font-medium">{RECOMMENDATION_LABELS[category]}</p>
                  {recommendation ? (
                    <>
                      <StatusPill tone="success" label={`Rank #${recommendation.priorityRank}`} />
                      <p className="text-meta text-muted-foreground">
                        {formatNumber(recommendation.gapIds.length)} finding
                        {recommendation.gapIds.length === 1 ? '' : 's'} bundled
                      </p>
                    </>
                  ) : (
                    <StatusPill
                      tone="unmeasured"
                      label={plan && notCovered ? 'No evidence yet' : 'Not built'}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {plan && plan.notCovered.length > 0 ? (
            <p className="text-meta text-muted-foreground">
              {formatNumber(plan.notCovered.length)} categor
              {plan.notCovered.length === 1 ? 'y has' : 'ies have'} no qualifying finding yet: no
              stored audit has produced evidence that classifies into {plan.notCovered.length === 1 ? 'it' : 'them'}.
              Building the plan again after a relevant audit is what fills {plan.notCovered.length === 1 ? 'it' : 'them'}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── 30/60/90 ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">30/60/90-day proposal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            The plan ranks work but carries no dates, so a horizon shows only what is{' '}
            <strong className="font-medium text-foreground">genuinely dated</strong>: cycles,
            milestones and work due dates. Nothing here is assigned to a horizon by this screen —
            putting a recommendation into a horizon is what committing a cycle does, and that is
            deliberate, because a commitment with a date is a promise and a ranking is not.
          </p>

          {now === null ? (
            <p className="text-table text-muted-foreground">Resolving the current date…</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              {horizons.map(({ horizon, items, milestones: due, cycles: overlapping }) => {
                const empty =
                  items.length === 0 && due.length === 0 && overlapping.length === 0;
                return (
                  <div key={horizon.key} className="space-y-3 rounded-lg border border-border p-3">
                    <h3 className="text-table font-medium">{horizon.label}</h3>

                    {empty ? (
                      <p className="text-meta text-muted-foreground">
                        Nothing dated falls in this window. That is not a statement that no work is
                        planned — it means no commitment with a date lands here.
                      </p>
                    ) : null}

                    {overlapping.length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-meta font-medium text-muted-foreground">Cycles</p>
                        <ul className="space-y-1">
                          {overlapping.map((cycle) => (
                            <li key={cycle.id} className="text-table">
                              <Link
                                href={`/projects/${projectId}/cycles/${cycle.id}`}
                                className="underline-offset-4 hover:underline"
                              >
                                {cycle.name}
                              </Link>
                              <span className="block text-meta text-muted-foreground">
                                <Timestamp value={cycle.startsOn} dateOnly /> –{' '}
                                <Timestamp value={cycle.endsOn} dateOnly /> · {cycle.status}
                                {cycle.committedCount > 0
                                  ? ` · ${formatNumber(cycle.committedCount)} committed`
                                  : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {due.length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-meta font-medium text-muted-foreground">Milestones</p>
                        <ul className="space-y-1">
                          {due.map((milestone) => (
                            <li key={milestone.id} className="text-table">
                              {milestone.title}
                              <span className="block text-meta text-muted-foreground">
                                due <Timestamp value={milestone.dueAt ?? milestone.updatedAt} dateOnly /> ·{' '}
                                {milestone.status}
                                {milestone.clientVisible ? '' : ' · internal'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {items.length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-meta font-medium text-muted-foreground">Work due</p>
                        <ul className="space-y-1">
                          {items.map((item) => (
                            <li key={item.id} className="text-table">
                              <Link
                                href={`/projects/${projectId}/work/${item.id}`}
                                className="underline-offset-4 hover:underline"
                              >
                                {item.title}
                              </Link>
                              <span className="block text-meta text-muted-foreground">
                                due <Timestamp value={item.dueAt ?? item.updatedAt} dateOnly /> ·{' '}
                                {item.status} · {item.category}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-meta text-muted-foreground">
            Dated commitments become firm when a cycle is committed, which freezes its scope. Until
            then everything above is a proposal.{' '}
            <Link href={`/projects/${projectId}/cycles`} className="underline underline-offset-4">
              Open the cycle board
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
