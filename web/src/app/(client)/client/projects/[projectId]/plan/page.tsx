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
  getPortalCommitments,
  getPortalPhases,
  getPortalPlan,
  type CommitmentStatus,
  type PortalCommitment,
  type PortalCycle,
  type PortalMilestone,
  type PortalPhase,
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
  const [commitments, setCommitments] = useState<PortalCommitment[]>([]);
  const [phases, setPhases] = useState<PortalPhase[]>([]);
  const [checklist, setChecklist] = useState<PortalChecklist | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, planResult, commitmentsResult, phasesResult, checklistResult] = await Promise.allSettled([
          listPortalProjectSummaries({ signal }),
          getPortalPlan(projectId, { signal }),
          getPortalCommitments(projectId, { signal }),
          // C3, Option B — optional: most projects have no phases yet, and this
          // screen must render fine either way.
          getPortalPhases(projectId, { signal }),
          getPortalChecklist(projectId, { signal }),
        ]);
        if (projects.status === 'rejected') throw projects.reason;
        setProject(projects.value.find((entry) => entry.id === projectId) ?? null);
        if (planResult.status === 'fulfilled') setPlan(planResult.value);
        if (commitmentsResult.status === 'fulfilled') setCommitments(commitmentsResult.value);
        if (phasesResult.status === 'fulfilled') setPhases(phasesResult.value);
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
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
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
            Work periods and milestones can still exist, but there is no
            service period on file for this project. Your delivery lead can
            attach one.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── Engagement phases (C3, Option B) ─────────────────────────────── */}
      {/* Purely a client-facing grouping over the work periods/commitments
          below — a phase carries no status logic of its own beyond a simple
          display hint. Only shown once the delivery team has set phases up;
          many projects will have none, and that is not an error state. */}
      {phases.length > 0 ? (
        <section aria-labelledby="phases-heading" className="space-y-3">
          <h2 id="phases-heading" className="text-subsection font-semibold tracking-tight">
            Your engagement
          </h2>
          <div className="space-y-3">
            {phases.map((phase) => (
              <PhaseCard key={phase.id} phase={phase} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── This work period ───────────────────────────────────────────── */}
      {/* §4.3: a "cycle" is internal shorthand for the period of work the
          commitments below cover, so the client reads "work period". */}
      <section aria-labelledby="cycle-heading" className="space-y-3">
        <h2 id="cycle-heading" className="text-subsection font-semibold tracking-tight">
          This work period
        </h2>
        {liveCycle ? (
          <CycleCard cycle={liveCycle} projectId={projectId} />
        ) : plan.cycles.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="the current work period"
                prerequisite="No work period has been planned for this project yet. Your delivery team publishes one when a period of work starts."
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="the current work period"
                prerequisite="No work period is active right now. Your 30-day plan below lists what has been planned and finished."
              />
            </CardContent>
          </Card>
        )}
      </section>

      {/* ── Commitments ────────────────────────────────────────────────── */}
      <section aria-labelledby="commitments-heading" className="space-y-3">
        <h2 id="commitments-heading" className="text-subsection font-semibold tracking-tight">
          Your 30-day plan
        </h2>
        {commitments.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="plan commitments"
                prerequisite="Nothing has been agreed for this period yet."
              />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {commitments.map((commitment) => (
              <CommitmentCard key={commitment.id} commitment={commitment} />
            ))}
          </div>
        )}
      </section>

      {/* ── Roadmap ────────────────────────────────────────────────────── */}
      <section aria-labelledby="roadmap-heading" className="space-y-3">
        <h2 id="roadmap-heading" className="text-subsection font-semibold tracking-tight">
          30-day plan
        </h2>
        {plan.cycles.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                variant="not-measured"
                subject="the 30-day plan"
                prerequisite="No work period has been planned yet."
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
                            ? `${cycle.deliveredCount} of ${cycle.committedCount} agreed items delivered`
                            : 'not agreed yet'}
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
                              {change.requiresReconfirmation ? ' (needs your confirmation)' : ''}
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
                        <p className="mt-1 text-meta text-muted-foreground">
                          {blockedReasonLabel(item.blockedReason)}
                        </p>
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
                <AlertTitle>This work period holds {cycle.currentCount} items now</AlertTitle>
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
                        {change.requiresReconfirmation ? ' (needs your confirmation)' : ''}
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
          // §3.5 — an uncommitted work period has no denominator, so no progress is drawn.
          <p className="text-table text-muted-foreground">
            This work period has not been agreed yet, so there is no agreed count
            to measure delivery against. {cycle.currentCount} item
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

/**
 * One engagement phase (C3, Option B) — a client-facing grouping label over
 * the work periods and commitments assigned to it. A phase has no lifecycle
 * of its own: `status` is a simple display hint the delivery team sets
 * directly, never something this screen infers or gates on. Cycles/
 * commitments under it render as compact rows rather than full cards, since
 * the full detail is already shown in the sections below this one.
 */
function PhaseCard({ phase }: { phase: PortalPhase }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <CardTitle className="text-subsection">{phase.name}</CardTitle>
        <StatusPill label={phaseStatusLabel(phase.status)} tone={phaseStatusTone(phase.status)} />
      </CardHeader>
      <CardContent className="space-y-3">
        {phase.cycles.length === 0 && phase.commitments.length === 0 ? (
          <p className="text-table text-muted-foreground">Nothing has been shared with you under this phase yet.</p>
        ) : (
          <>
            {phase.cycles.length > 0 ? (
              <div className="space-y-1">
                <p className="text-meta font-medium text-muted-foreground">Work periods</p>
                <ul className="space-y-1">
                  {phase.cycles.map((cycle) => (
                    <li key={cycle.id} className="flex flex-wrap items-center justify-between gap-2 text-table">
                      <span>{cycle.name}</span>
                      <StatusPill label={cycleStatusLabel(cycle.status)} tone={cycleStatusTone(cycle.status)} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {phase.commitments.length > 0 ? (
              <div className="space-y-1">
                <p className="text-meta font-medium text-muted-foreground">Commitments</p>
                <ul className="space-y-1">
                  {phase.commitments.map((commitment) => (
                    <li key={commitment.id} className="flex flex-wrap items-center justify-between gap-2 text-table">
                      <span>{commitment.title}</span>
                      <StatusPill
                        label={commitmentStatusLabel(commitment.status)}
                        tone={commitmentStatusTone(commitment.status)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function phaseStatusLabel(status: PortalPhase['status']): string {
  switch (status) {
    case 'active':
      return 'Current';
    case 'complete':
      return 'Complete';
    default:
      return 'Upcoming';
  }
}

function phaseStatusTone(status: PortalPhase['status']): StatusTone {
  switch (status) {
    case 'active':
      return 'info';
    case 'complete':
      return 'success';
    default:
      return 'unmeasured';
  }
}

/**
 * One plan commitment (§6.1-6.2) — distinct from a WorkItem or a content
 * schedule entry. Progress is rendered exactly as the server labels it
 * ("3 of 10 articles published"), never recomputed into a percentage here.
 */
function CommitmentCard({ commitment }: { commitment: PortalCommitment }) {
  const showBar = commitment.progress.kind === 'countable' && commitment.progress.targetCount != null;
  const percent = showBar
    ? Math.min(100, Math.round((commitment.progress.verifiedCount / (commitment.progress.targetCount ?? 1)) * 100))
    : 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-subsection">{commitment.title}</CardTitle>
          {commitment.reason ? <p className="text-meta text-muted-foreground">{commitment.reason}</p> : null}
        </div>
        <StatusPill label={commitmentStatusLabel(commitment.status)} tone={commitmentStatusTone(commitment.status)} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
          <span>{commitment.accountableLead}</span>
          {commitment.targetDate ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                By <Timestamp value={commitment.targetDate} dateOnly />
              </span>
            </>
          ) : null}
        </div>

        <p className="text-table font-medium">{commitment.progress.label}</p>
        {showBar ? (
          <Progress value={percent} aria-label={commitment.progress.label} />
        ) : null}

        {commitment.nextClientAction ? (
          <Button asChild size="sm" variant="outline">
            <Link href={commitment.nextClientAction.destination}>
              {commitment.nextClientAction.title}
              <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </Button>
        ) : null}

        {commitment.scopeChanges.length > 0 ? (
          <details className="text-meta">
            <summary className="cursor-pointer text-muted-foreground">
              {commitment.scopeChanges.length} change{commitment.scopeChanges.length === 1 ? '' : 's'} to this
              commitment
            </summary>
            <ul className="mt-1 space-y-1 pl-4">
              {commitment.scopeChanges.map((change, index) => (
                <li key={`${change.at}-${index}`} className="text-muted-foreground">
                  <Timestamp value={change.at} dateOnly /> — {change.reason}
                  {change.requiresReconfirmation ? ' (needs your confirmation)' : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function commitmentStatusLabel(status: CommitmentStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'proposed':
      return 'Proposed';
    case 'agreed':
      return 'Agreed';
    case 'active':
      return 'In progress';
    case 'needs-attention':
      return 'Needs attention';
    case 'completed':
      return 'Completed';
    case 'closed':
      return 'Closed';
    case 'cancelled':
      return 'Cancelled';
    case 'superseded':
      return 'Superseded';
    default:
      return status;
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

function MilestoneRow({ milestone, now }: { milestone: PortalMilestone; now: number }) {
  const due = milestone.dueOn ? new Date(milestone.dueOn) : null;
  const overdue =
    due !== null && !Number.isNaN(due.getTime()) && due.getTime() < now && milestone.status !== 'met';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="text-table font-medium">{milestone.title}</div>
        {milestone.dueOn ? (
          <p className="text-meta text-muted-foreground">
            Due <Timestamp value={milestone.dueOn} dateOnly />
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
      return 'Agreed';
    case 'active':
      return 'In progress';
    case 'review':
      return 'In review';
    case 'closed':
      return 'Closed';
    default:
      // §4.3: an unmapped state is never printed as a slug.
      return 'Status not recorded';
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
    dueDate: item.dueOn ?? undefined,
    status: toViewWorkStatus(item.status),
    blocker: item.status === 'blocked' ? (blockedReasonLabel(item.blockedReason) ?? undefined) : undefined,
    evidenceHref: `/client/projects/${item.projectId}/work/${item.id}`,
    nextAction: undefined,
  };
}

/** Client-facing text for the normalized blocker category the backend sends
 * (never the raw internal blockedReason text). */
function blockedReasonLabel(reason: PortalWorkItem['blockedReason']): string | null {
  switch (reason) {
    case 'client-action':
      return 'Waiting on something from you.';
    case 'approval':
      return 'Waiting on an approval.';
    case 'dependency':
      return 'Waiting on other work to finish first.';
    case 'other':
      return 'Waiting on something on our side.';
    default:
      return null;
  }
}
