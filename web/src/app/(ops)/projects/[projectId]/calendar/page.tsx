'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import { listApprovals, type ApprovalRequest } from '@/services/approvals';
import { listPortfolioReports } from '@/services/calendar';
import {
  listMilestones,
  listWorkItems,
  WORK_ITEM_STATUS_LABEL,
  type Milestone,
  type WorkItem,
} from '@/services/delivery-plan';
import {
  describeCadenceFrequency,
  listCadenceRules,
  type CadenceRuleDto,
} from '@/services/jobs';
import { getProject } from '@/services/projects';

/**
 * PJ10 — Project calendar.
 *
 * design_plan.md §4.3: *"Deliverables, review meetings, run cadence, publication
 * plan"*, support "P schedule reads; G06/G07/G11".
 *
 * Project-scoped, so three of the four bands have a real reader — which is the
 * difference between this screen and the portfolio calendar (OP13), where only
 * two did:
 *
 *  - **Deliverables** — work items with a due date, and milestones.
 *  - **Review meetings** — approvals **for this project**, each carrying its own
 *    `dueAt`. The portfolio-wide version has no reader; this one does.
 *  - **Run cadence** — the project's cadence rules, with `nextRunAt`, `lastRunAt`
 *    and `lastError`, each in its own timezone. §7.3's warning is rendered next
 *    to them: *"A saved schedule is not proof of a running worker."* The
 *    `configured` flag is shown because a kind with no rule row comes back with
 *    documented defaults, and defaults are not a schedule.
 *  - **Publication plan** — G11, and this one is a real gap: publishing to a CMS
 *    or channel has no contract. What is shown instead is what the API does know
 *    — released reports and their released dates — with the absence stated
 *    rather than implied.
 *
 * Timezone: every timestamp goes through `Timestamp`, and cadence timestamps are
 * pinned to each rule's own stored zone rather than the viewer's, because a
 * schedule that displays in the wrong zone is a schedule that looks wrong.
 */
interface DeliverableRow {
  id: string;
  kind: 'work' | 'milestone';
  title: string;
  /** ISO 8601, or null when nothing is dated. */
  date: string | null;
  status: string;
  href?: string;
  /** Work only. */
  clientVisible?: boolean;
  /** Milestones only. */
  clientVisibleMilestone?: boolean;
}

export default function ProjectCalendarPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [projectName, setProjectName] = useState<string | null>(null);
  const [work, setWork] = useState<WorkItem[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [cadences, setCadences] = useState<CadenceRuleDto[]>([]);
  const [releases, setReleases] = useState<
    Awaited<ReturnType<typeof listPortfolioReports>>['items']
  >([]);

  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [approvalError, setApprovalError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [workRows, milestoneRows, cadenceRows, reportPage, project] = await Promise.all([
        listWorkItems(projectId, undefined, { signal }),
        listMilestones(projectId, { signal }).catch(() => []),
        listCadenceRules(projectId, { signal }).catch(() => []),
        listPortfolioReports({ projectId, pageSize: 100 }, { signal }).catch(() => ({
          items: [],
          page: 1,
          pageSize: 100,
          total: 0,
        })),
        getProject(projectId, { signal }).catch(() => null),
      ]);
      setWork(workRows);
      setMilestones(milestoneRows);
      setCadences(cadenceRows);
      setReleases(reportPage.items);
      if (project) setProjectName(project.name);

      // Approvals are their own read with their own failure mode: a project
      // whose approvals cannot be listed still has a useful calendar.
      try {
        const result = await listApprovals(projectId, undefined, { signal });
        setApprovals(result.requests);
        setApprovalError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setApprovalError(toApiError(caught));
      }
    },
    [projectId],
  );

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

  const deliverables = useMemo<DeliverableRow[]>(() => {
    const rows: DeliverableRow[] = [];
    for (const item of work) {
      rows.push({
        id: `work:${item.id}`,
        kind: 'work',
        title: item.title,
        date: item.dueAt,
        status: WORK_ITEM_STATUS_LABEL[item.status as keyof typeof WORK_ITEM_STATUS_LABEL] ?? item.status,
        href: `/projects/${projectId}/work/${item.id}`,
        clientVisible: item.clientVisible,
      });
    }
    for (const milestone of milestones) {
      rows.push({
        id: `milestone:${milestone.id}`,
        kind: 'milestone',
        title: milestone.title,
        date: milestone.dueAt,
        status: milestone.status,
        clientVisibleMilestone: milestone.clientVisible,
      });
    }
    // Undated rows sort last: a missing date is not the earliest date.
    return rows.sort((a, b) => {
      if (!a.date && !b.date) return a.title.localeCompare(b.title);
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });
  }, [work, milestones, projectId]);

  const undatedCount = deliverables.filter((row) => !row.date).length;

  const deliverableColumns: ColumnDef<DeliverableRow>[] = [
    {
      key: 'title',
      header: 'Deliverable',
      accessor: (row) => row.title,
      sortable: true,
      render: (row) =>
        row.href ? (
          <Link href={row.href} className="font-medium underline-offset-4 hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="font-medium">{row.title}</span>
        ),
    },
    {
      key: 'kind',
      header: 'Kind',
      accessor: (row) => (row.kind === 'work' ? 'Work item' : 'Milestone'),
      sortable: true,
      render: (row) => (row.kind === 'work' ? 'Work item' : 'Milestone'),
    },
    {
      key: 'date',
      header: 'Due',
      accessor: (row) => row.date,
      sortable: true,
      emptyLabel: 'No due date',
      render: (row) =>
        row.date ? (
          <Timestamp value={row.date} dateOnly />
        ) : (
          <span className="text-meta text-muted-foreground">No due date</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
    },
    {
      key: 'visibility',
      header: 'Reach',
      accessor: (row) => (row.clientVisible ?? row.clientVisibleMilestone ? 'client' : 'internal'),
      sortable: true,
      render: (row) =>
        row.clientVisible ?? row.clientVisibleMilestone ? (
          <span>Client-visible</span>
        ) : (
          <span className="text-muted-foreground">Internal only</span>
        ),
    },
  ];

  const reviewRows = approvals.filter((approval) => Boolean(approval.dueAt));
  const undatedReviews = approvals.length - reviewRows.length;

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
          title="Calendar"
        />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(projectName ? [{ label: projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Calendar' },
        ]}
        title="Calendar"
        context="What is dated on this project: deliverables, review decisions, run cadence and releases."
      />

      {/* ── Deliverables ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-subsection font-semibold">Deliverables</h2>
          <span className="text-meta text-muted-foreground">
            {formatNumber(deliverables.length - undatedCount)} dated ·{' '}
            {formatNumber(undatedCount)} undated
          </span>
        </div>

        {undatedCount > 0 ? (
          <Alert>
            <AlertDescription>
              {formatNumber(undatedCount)} deliverable{undatedCount === 1 ? '' : 's'} ha
              {undatedCount === 1 ? 's' : 've'} no due date and{' '}
              {undatedCount === 1 ? 'is' : 'are'} listed at the end rather than placed on a day.
              &ldquo;No due date&rdquo; is not the first of the month.
            </AlertDescription>
          </Alert>
        ) : null}

        <DataTable<DeliverableRow>
          columns={deliverableColumns}
          rows={deliverables}
          getRowId={(row) => row.id}
          caption="Dated deliverables on this project"
          minTableWidth="52rem"
          emptyState={
            <EmptyState
              variant="not-measured"
              subject="dated deliverables on this project"
              prerequisite="work items or milestones with a due date"
              layout="inline"
            >
              <p>
                Nothing on this project carries a date. Work without a due date is not on a calendar
                at all — it is unscoped rather than unscheduled.
              </p>
            </EmptyState>
          }
        />
      </section>

      {/* ── Review meetings ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Review meetings</CardTitle>
          <span className="text-meta text-muted-foreground">
            {formatNumber(reviewRows.length)} dated
            {undatedReviews > 0 ? ` · ${formatNumber(undatedReviews)} with no due date` : ''}
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          {approvalError ? (
            <ErrorState
              error={approvalError}
              layout="inline"
              onRetry={() => void load()}
              preserveNotice="The other bands on this page are unaffected."
            />
          ) : approvals.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="review decisions on this project"
              prerequisite="an approval requested against a version of an artifact"
              layout="inline"
            >
              <p>
                No approval has been requested on this project, so there are no review dates to
                place. This is a state of the project, not a missing reader — approvals are read
                directly from this project&apos;s own list.
              </p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {approvals.map((approval) => (
                <li
                  key={approval.id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-table font-medium">{approval.title}</p>
                    <p className="text-meta text-muted-foreground">
                      {approval.artifactType} · revision{' '}
                      {approval.artifactRevision ?? notMeasuredLabel()} · reviewer:{' '}
                      {approval.requiredReviewerId ? (
                        <span className="font-mono">{approval.requiredReviewerId}</span>
                      ) : (
                        'not stated'
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {approval.dueAt ? (
                      <Timestamp value={approval.dueAt} />
                    ) : (
                      <span className="text-meta text-muted-foreground">No due date</span>
                    )}
                    <StatusPill
                      tone={approvalStatusTone(approval.status)}
                      label={approval.status.replace(/-/g, ' ')}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {undatedReviews > 0 ? (
            <p className="text-meta text-muted-foreground">
              {formatNumber(undatedReviews)} request{undatedReviews === 1 ? '' : 's'} carr
              {undatedReviews === 1 ? 'ies' : 'y'} no due date. They are visible above but cannot be
              placed on a day, and they are not counted as due today.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Run cadence ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Run cadence</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>A configured schedule is not a running worker</AlertTitle>
            <AlertDescription>
              §7.3 warns that the existing schedulers poll hourly and use approximate day offsets,
              and that a saved schedule is not proof of a running worker. The last success and last
              error below are the evidence; the next-due time is an intent.
            </AlertDescription>
          </Alert>

          {cadences.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="cadence rules for this project"
              prerequisite="a schedulable task kind (design_plan G07)"
              layout="inline"
            />
          ) : (
            <ul className="divide-y divide-border">
              {cadences.map((rule) => (
                <li key={rule.taskKind} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-table font-medium">{rule.taskKind}</span>
                    {rule.configured ? (
                      rule.pausedAt ? (
                        <StatusPill tone="warning" label="Paused" />
                      ) : rule.enabled ? (
                        <StatusPill tone="info" label="Enabled" />
                      ) : (
                        <StatusPill tone="neutral" label="Disabled" />
                      )
                    ) : (
                      // Defaults, not a stored schedule — the distinction matters.
                      <StatusPill tone="unmeasured" label="No rule stored" />
                    )}
                  </div>

                  <p className="text-table text-muted-foreground">
                    {describeCadenceFrequency(rule)} · stored hour {formatNumber(rule.hour)} ·{' '}
                    <span className="font-mono">{rule.timezone}</span>
                  </p>

                  <dl className="grid gap-1 text-meta sm:grid-cols-2">
                    <InlineRow label="Next due">
                      {rule.nextRunAt ? (
                        <Timestamp value={rule.nextRunAt} timeZone={rule.timezone} />
                      ) : (
                        <span className="text-muted-foreground">{notMeasuredLabel()}</span>
                      )}
                    </InlineRow>
                    <InlineRow label="Last run">
                      {rule.lastRunAt ? (
                        <Timestamp value={rule.lastRunAt} timeZone={rule.timezone} />
                      ) : (
                        <span className="text-muted-foreground">
                          {notMeasuredLabel()} — the rule has never run under the scheduler
                        </span>
                      )}
                    </InlineRow>
                    <InlineRow label="Last status">
                      {rule.lastStatus ?? (
                        <span className="text-muted-foreground">{notMeasuredLabel()}</span>
                      )}
                    </InlineRow>
                    <InlineRow label="Cost cap">
                      {rule.maxCostUsd === null ? (
                        <span className="text-muted-foreground">No cap recorded</span>
                      ) : (
                        `$${rule.maxCostUsd.toFixed(2)} per run`
                      )}
                    </InlineRow>
                  </dl>

                  {rule.lastError ? (
                    <p className="text-meta text-danger-foreground">
                      Last error: {rule.lastError}
                    </p>
                  ) : null}

                  {rule.prerequisites.length > 0 ? (
                    <p className="text-meta text-muted-foreground">
                      Prerequisites: {rule.prerequisites.join(', ')}
                    </p>
                  ) : (
                    <p className="text-meta text-muted-foreground">
                      No prerequisites recorded for this rule.
                    </p>
                  )}

                  {!rule.configured ? (
                    <p className="text-meta text-warning-foreground">
                      These are the documented defaults for this task kind, not stored values. Until
                      a rule is saved, nothing schedules this work.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Publication plan ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Publication plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            What has actually been released, with the date the API records for each release. A
            release date is a fact about a revision, not a plan.
          </p>

          {releases.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="released reports on this project"
              prerequisite="a report that has been released to the client"
              layout="inline"
            />
          ) : (
            <ul className="divide-y divide-border">
              {releases.map((report) => (
                <li key={report.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <Link
                    href={`/projects/${projectId}/reports/${report.slug}`}
                    className="text-table underline-offset-4 hover:underline"
                  >
                    {report.title}
                  </Link>
                  <span className="flex flex-wrap items-center gap-2">
                    {report.releasedAt ? (
                      <Timestamp value={report.releasedAt} dateOnly />
                    ) : (
                      <span className="text-meta text-muted-foreground">Not released</span>
                    )}
                    <StatusPill tone="neutral" label={report.status.replace(/-/g, ' ')} />
                  </span>
                </li>
              ))}
            </ul>
          )}

          <EmptyState
            variant="not-measured"
            subject="a channel publication schedule"
            prerequisite="CMS and social publishing contracts (design_plan G11)"
            layout="panel"
          >
            <p>
              Publishing to a CMS or a social channel has no contract yet, so this calendar cannot
              schedule a publication. Planning content in advance is a content-calendar concern and
              is likewise G11.
            </p>
            <p>
              What exists today is the release record above: an operator releases a report and the
              API records when. Nothing here schedules a future publication, and the absence is not
              a statement that none is planned.
            </p>
          </EmptyState>
        </CardContent>
      </Card>
    </div>
  );
}

function InlineRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function approvalStatusTone(
  status: string,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'unmeasured' {
  switch (status) {
    case 'approved':
      return 'success';
    case 'pending':
      return 'warning';
    case 'changes-requested':
      return 'info';
    case 'cancelled':
      return 'neutral';
    case 'invalidated':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}
