'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowRight, CalendarCheck, Flag, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { WorkList } from '@/components/patterns/WorkRow';
import { formatDate } from '@/lib/format';
import { toViewWorkStatus } from '@/lib/work-mapping';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  getPortalPlan,
  type PortalCycle,
  type PortalMilestone,
  type PortalPlan,
  type PortalWorkItem,
} from '@/services/portal-plan';
import { getPortalChecklist, type PortalChecklist } from '@/services/portal-profile';
import type { WorkItem as WorkViewItem } from '@/types';

/**
 * CP06 — Plan and progress.
 *
 * design_plan.md §4.5: *"Published roadmap, cycle commitments, milestones,
 * blockers, client actions."*
 *
 * The commitment arithmetic is the part that has to be exactly right, because
 * it is the number a client will hold the delivery team to:
 *
 *  - `committedCount` is **frozen at commit time**. It is the denominator of
 *    "delivered 8 of 10 committed", and it is never recomputed.
 *  - Adding or removing work afterwards does not move that denominator; each
 *    change is appended to `scopeChanges` with a reason, and this page lists
 *    those reasons rather than quietly showing a different total.
 *  - `deliveredCount` counts work items in the cycle that reached `verified` —
 *    an unverified deliverable is not delivered.
 *
 * What "published" means here is what the backend serves: the portal plan is
 * the client's own view of the engagement (G06), so there is no separate
 * draft/published flag to render. Work items are only in this list because they
 * are flagged client-visible; internal items are absent rather than hidden.
 *
 * "Client actions" are read from the onboarding checklist and the access
 * requests they hold up — the same records the welcome screen shows — so the
 * page never invents a to-do the backend does not know about.
 */
export default function ClientPlanPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params.projectId;

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [plan, setPlan] = useState<PortalPlan | null>(null);
  const [checklist, setChecklist] = useState<PortalChecklist | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, planResult, checklistResult] = await Promise.allSettled([
          listPortalProjectSummaries({ signal }),
          getPortalPlan(projectId, { signal }),
          getPortalChecklist(projectId, { signal }),
        ]);
        if (projects.status === 'rejected') throw projects.reason;
        setProject(projects.value.find((entry) => entry.id === projectId) ?? null);
        if (planResult.status === 'fulfilled') setPlan(planResult.value);
        if (checklistResult.status === 'fulfilled') setChecklist(checklistResult.value);
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

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Plan" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
    );
  }

  if (plan === null) {
    return (
      <div className="space-y-6">
        <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />
        <PageHeader title="Plan" breadcrumbs={[{ label: project.name, href: `/client/projects/${projectId}` }, { label: 'Plan' }]} />
        <EmptyState
          variant="not-measured"
          subject="the plan"
          prerequisite="It could not be read just now. Reload to try again."
        />
      </div>
    );
  }

  const now = Date.now();
  const liveCycle =
    plan.cycles.find((cycle) => cycle.status === 'active') ??
    plan.cycles.find((cycle) => cycle.status === 'review') ??
    plan.cycles.find((cycle) => cycle.status === 'committed') ??
    null;
  const blockedWork = plan.workItems.filter((item) => item.status === 'blocked');
  const clientActions = [
    ...(checklist?.blocking ?? []).map((entry) => ({
      key: `request:${entry.requestId}`,
      title: entry.title,
      detail:
        entry.blockedWorkLinks.length > 0
          ? `Holding up: ${entry.blockedWorkLinks
              .map((link) => link.title ?? 'an item')
              .join(', ')}`
          : 'Nothing is waiting on it directly.',
      dueAt: entry.dueAt,
      overdue: entry.overdue,
      href: `/client/projects/${projectId}/welcome`,
      actionLabel: 'Open checklist',
    })),
    ...(checklist?.items ?? [])
      .filter((item) => item.owner === 'client' && item.state === 'outstanding' && !item.requestId)
      .map((item) => ({
        key: `item:${item.key}`,
        title: item.label,
        detail: item.detail,
        dueAt: item.dueAt,
        overdue: false,
        href: `/client/projects/${projectId}/welcome`,
        actionLabel: 'Open checklist',
      })),
  ];

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Plan' },
        ]}
        title="Plan and progress"
        context={
          plan.engagement
            ? `${plan.engagement.name} · ${plan.engagement.serviceTier}${
                plan.engagement.endsOn ? ` · to ${formatDate(plan.engagement.endsOn)}` : ''
              }`
            : 'What we committed to, what has been delivered, and what is waiting.'
        }
      />

      {plan.engagement === null ? (
        <Alert>
          <AlertTitle>No engagement is attached to this project</AlertTitle>
          <AlertDescription>
            Cycles and milestones can still exist, but there is no service period
            on file for this project. Your delivery lead can attach one.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── This cycle ─────────────────────────────────────────────────── */}
      <section aria-labelledby="cycle-heading" className="space-y-3">
        <h2 id="cycle-heading" className="text-subsection font-semibold tracking-tight">
          This cycle
        </h2>
        {liveCycle ? (
          <CycleCard cycle={liveCycle} projectId={projectId} />
        ) : plan.cycles.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="the current cycle"
                prerequisite="No cycle has been created for this project yet. Your delivery team publishes one when a work period starts."
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="the current cycle"
                prerequisite="No cycle is active right now. The roadmap below lists what has been planned and finished."
              />
            </CardContent>
          </Card>
        )}
      </section>

      {/* ── Roadmap ────────────────────────────────────────────────────── */}
      <section aria-labelledby="roadmap-heading" className="space-y-3">
        <h2 id="roadmap-heading" className="text-subsection font-semibold tracking-tight">
          Roadmap
        </h2>
        {plan.cycles.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="the roadmap"
                prerequisite="No cycle has been planned yet."
              />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {plan.cycles
              .slice()
              .sort((a, b) => (a.startsOn < b.startsOn ? 1 : -1))
              .map((cycle) => (
                <Card key={cycle.id}>
                  <CardContent className="space-y-2 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-table font-medium">{cycle.name}</div>
                        <div className="text-meta text-muted-foreground">
                          <Timestamp value={cycle.startsOn} dateOnly /> –{' '}
                          <Timestamp value={cycle.endsOn} dateOnly />
                        </div>
                      </div>
                      <span className="flex items-center gap-2">
                        <StatusPill
                          label={cycleStatusLabel(cycle.status)}
                          tone={cycleStatusTone(cycle.status)}
                        />
                        <span className="text-meta text-muted-foreground">
                          {cycle.committedAt
                            ? `${cycle.deliveredCount} of ${cycle.committedCount} committed delivered`
                            : 'not committed yet'}
                        </span>
                      </span>
                    </div>
                    {cycle.goal ? <p className="text-table">{cycle.goal}</p> : null}
                    {cycle.scopeChanges.length > 0 ? (
                      <details className="text-meta">
                        <summary className="cursor-pointer text-muted-foreground">
                          {cycle.scopeChanges.length} scope change
                          {cycle.scopeChanges.length === 1 ? '' : 's'} after commit
                        </summary>
                        <ul className="mt-1 space-y-1 pl-4">
                          {cycle.scopeChanges.map((change, index) => (
                            <li key={`${change.at}-${index}`} className="text-muted-foreground">
                              <Timestamp value={change.at} dateOnly /> — {change.reason}
                              {change.added.length > 0 ? ` (+${change.added.length})` : ''}
                              {change.removed.length > 0 ? ` (−${change.removed.length})` : ''}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
          </div>
        )}
      </section>

      {/* ── Milestones ─────────────────────────────────────────────────── */}
      <section aria-labelledby="milestones-heading" className="space-y-3">
        <h2 id="milestones-heading" className="text-subsection font-semibold tracking-tight">
          Milestones
        </h2>
        <Card>
          <CardContent className="py-4">
            {plan.milestones.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="milestones"
                prerequisite="None have been published for this project yet."
              />
            ) : (
              <ul className="divide-y divide-border">
                {plan.milestones.map((milestone) => (
                  <MilestoneRow key={milestone.id} milestone={milestone} now={now} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Blockers ───────────────────────────────────────────────────── */}
      <section aria-labelledby="blockers-heading" className="space-y-3">
        <h2 id="blockers-heading" className="text-subsection font-semibold tracking-tight">
          Blockers
        </h2>
        <Card>
          <CardContent className="space-y-3 py-4">
            {blockedWork.length === 0 ? (
              <p className="flex items-center gap-2 text-table text-muted-foreground">
                <CalendarCheck aria-hidden="true" className="h-4 w-4" />
                Nothing shared with you is blocked.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {blockedWork.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ShieldAlert
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0 text-warning-foreground"
                        />
                        <span className="text-table font-medium">{item.title}</span>
                      </div>
                      {item.blockedReason ? (
                        <p className="mt-1 text-meta text-muted-foreground">{item.blockedReason}</p>
                      ) : (
                        <p className="mt-1 text-meta text-muted-foreground">
                          No reason was recorded for this blocker.
                        </p>
                      )}
                      {item.blockedOn ? (
                        <p className="text-meta text-muted-foreground">
                          Waiting on: {item.blockedOn}
                        </p>
                      ) : null}
                    </div>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/client/projects/${projectId}/work/${item.id}`}>
                        Open
                        <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Client actions ─────────────────────────────────────────────── */}
      <section aria-labelledby="client-actions-heading" className="space-y-3">
        <h2 id="client-actions-heading" className="text-subsection font-semibold tracking-tight">
          What needs you
        </h2>
        <Card>
          <CardContent className="space-y-3 py-4">
            {checklist === null ? (
              <p className="text-table text-muted-foreground">
                We could not read what is outstanding just now. Reload to try again.
              </p>
            ) : clientActions.length === 0 ? (
              <p className="text-table text-muted-foreground">
                Nothing is waiting on you. Anything that changes appears here and
                on the welcome checklist.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {clientActions.map((action) => (
                  <li
                    key={action.key}
                    className="flex flex-wrap items-start justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Flag aria-hidden="true" className="h-4 w-4 shrink-0 text-info-foreground" />
                        <span className="text-table font-medium">{action.title}</span>
                        {action.overdue ? <StatusPill label="Overdue" tone="warning" /> : null}
                      </div>
                      <p className="mt-1 text-meta text-muted-foreground">{action.detail}</p>
                      {action.dueAt ? (
                        <p className="text-meta text-muted-foreground">
                          Due <Timestamp value={action.dueAt} dateOnly />
                        </p>
                      ) : null}
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={action.href}>{action.actionLabel}</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── All shared work ────────────────────────────────────────────── */}
      <section aria-labelledby="shared-work-heading" className="space-y-3">
        <h2 id="shared-work-heading" className="text-subsection font-semibold tracking-tight">
          Shared work
        </h2>
        <Card>
          <CardContent className="py-4">
            {plan.workItems.length === 0 ? (
              <EmptyState variant="no-work" scope="project" />
            ) : (
              <WorkList
                items={plan.workItems.map((item) => toWorkViewItem(item))}
                label="Work shared with you"
                caption="Every item your delivery team has shared. Who each one is assigned to is not shown on this screen."
                onOpen={(item) => router.push(`/client/projects/${projectId}/work/${item.id}`)}
                emptyState={<EmptyState variant="no-work" scope="project" layout="inline" />}
              />
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/**
 * One cycle's commitment.
 *
 * The progress bar is **determinate and only shown when there is a frozen
 * denominator** — `committedCount > 0`. There is no indeterminate or animated
 * fill anywhere (§3.4 forbids simulated progress), and a cycle that holds a
 * different number of items now than it did at commit says so, with the reasons
 * listed underneath rather than a silently different total.
 */
function CycleCard({ cycle, projectId }: { cycle: PortalCycle; projectId: string }) {
  const committed = cycle.committedCount;
  const delivered = cycle.deliveredCount;
  const drift = cycle.currentCount - committed;
  const percent = committed > 0 ? Math.min(100, Math.round((delivered / committed) * 100)) : 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-subsection">{cycle.name}</CardTitle>
          <p className="text-meta text-muted-foreground">
            <Timestamp value={cycle.startsOn} dateOnly /> –{' '}
            <Timestamp value={cycle.endsOn} dateOnly />
          </p>
        </div>
        <StatusPill label={cycleStatusLabel(cycle.status)} tone={cycleStatusTone(cycle.status)} />
      </CardHeader>
      <CardContent className="space-y-4">
        {cycle.goal ? <p className="text-body">{cycle.goal}</p> : null}

        {cycle.committedAt ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-table">
                <span className="text-subsection font-semibold tabular-nums">{delivered}</span> of{' '}
                <span className="font-semibold tabular-nums">{committed}</span> committed items
                delivered
              </span>
              <span className="text-meta text-muted-foreground">
                Committed <Timestamp value={cycle.committedAt} dateOnly />
              </span>
            </div>
            <Progress value={percent} aria-label={`${delivered} of ${committed} committed items delivered`} />
            <p className="text-meta text-muted-foreground">
              The commitment is measured against the {committed} item
              {committed === 1 ? '' : 's'} committed on that date. Only work that
              has been verified counts as delivered.
            </p>
            {drift !== 0 ? (
              <Alert>
                <AlertTitle>The cycle holds {cycle.currentCount} items now</AlertTitle>
                <AlertDescription>
                  {drift > 0
                    ? `${drift} item${drift === 1 ? '' : 's'} were added after the commitment was made. `
                    : `${Math.abs(drift)} item${Math.abs(drift) === 1 ? '' : 's'} were removed after the commitment was made. `}
                  Each change is recorded with a reason rather than changing the
                  committed total:
                  <ul className="mt-1 list-disc pl-5">
                    {cycle.scopeChanges.map((change, index) => (
                      <li key={`${change.at}-${index}`}>
                        {change.reason}
                        {change.added.length > 0 ? ` (+${change.added.length})` : ''}
                        {change.removed.length > 0 ? ` (−${change.removed.length})` : ''}
                      </li>
                    ))}
                  </ul>
                  {cycle.scopeChanges.length === 0
                    ? 'No reason was recorded for the difference.'
                    : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : (
          // §3.5 — an uncommitted cycle has no denominator, so no progress is drawn.
          <p className="text-table text-muted-foreground">
            This cycle has not been committed yet, so there is no agreed count to
            measure delivery against. {cycle.currentCount} item
            {cycle.currentCount === 1 ? '' : 's'} are currently planned in it.
          </p>
        )}

        <Button asChild variant="outline" size="sm">
          <Link href={`/client/projects/${projectId}/results`}>
            See how this is showing up in results
            <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function MilestoneRow({ milestone, now }: { milestone: PortalMilestone; now: number }) {
  const due = milestone.dueAt ? new Date(milestone.dueAt) : null;
  const overdue =
    due !== null && !Number.isNaN(due.getTime()) && due.getTime() < now && milestone.status !== 'met';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="text-table font-medium">{milestone.title}</div>
        {milestone.description ? (
          <p className="mt-1 text-meta text-muted-foreground">{milestone.description}</p>
        ) : null}
        {milestone.dueAt ? (
          <p className="text-meta text-muted-foreground">
            Due <Timestamp value={milestone.dueAt} dateOnly />
            {overdue ? ' — past its date' : ''}
          </p>
        ) : (
          <p className="text-meta text-muted-foreground">No date set for this milestone.</p>
        )}
      </div>
      <StatusPill label={milestoneStatusLabel(milestone.status)} tone={milestoneStatusTone(milestone.status)} />
    </li>
  );
}

function cycleStatusLabel(status: string): string {
  switch (status) {
    case 'planning':
      return 'Planning';
    case 'committed':
      return 'Committed';
    case 'active':
      return 'In progress';
    case 'review':
      return 'In review';
    case 'closed':
      return 'Closed';
    default:
      return status;
  }
}

function cycleStatusTone(status: string): StatusTone {
  switch (status) {
    case 'active':
      return 'info';
    case 'review':
      return 'warning';
    case 'closed':
      return 'success';
    case 'committed':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function milestoneStatusLabel(status: string): string {
  switch (status) {
    case 'planned':
      return 'Planned';
    case 'at-risk':
      return 'At risk';
    case 'met':
      return 'Met';
    case 'missed':
      return 'Missed';
    default:
      return status;
  }
}

function milestoneStatusTone(status: string): StatusTone {
  switch (status) {
    case 'met':
      return 'success';
    case 'at-risk':
      return 'warning';
    case 'missed':
      return 'danger';
    default:
      return 'neutral';
  }
}

function toWorkViewItem(item: PortalWorkItem): WorkViewItem {
  return {
    id: item.id,
    deliverable: item.title,
    owner: 'Not shown here',
    dueDate: item.dueAt ?? undefined,
    status: toViewWorkStatus(item.status),
    blocker: item.status === 'blocked' ? (item.blockedReason ?? undefined) : undefined,
    evidenceHref: `/client/projects/${item.projectId}/work/${item.id}`,
    nextAction: undefined,
  };
}
