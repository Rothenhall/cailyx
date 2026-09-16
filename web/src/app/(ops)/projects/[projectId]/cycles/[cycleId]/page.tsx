'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { WorkCard, WorkList } from '@/components/patterns/WorkRow';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import {
  CYCLE_TRANSITIONS,
  WORK_CATEGORIES,
  WORK_CATEGORY_LABEL,
  WORK_DISCIPLINE_LABEL,
  WORK_ITEM_STATUS_LABEL,
  WORK_PRIORITIES,
  WORK_PRIORITY_LABEL,
  commitCycle,
  createWorkItem,
  getCycleDetail,
  setCycleStatus,
  updateWorkItem,
  type CycleDetail,
  type CycleStatus,
  type WorkCategory,
  type WorkDiscipline,
  type WorkItem,
  type WorkItemStatus,
  type WorkPriority,
} from '@/services/delivery-plan';
import { getProject } from '@/services/projects';
import type { WorkItem as WorkListItem } from '@/types';

/**
 * PJ08 — Cycle board.
 *
 * design_plan.md §4.3: *"Committed/backlog/active/review/blocked/verified,
 * owner and due dates"*.
 *
 * **The rule that shapes this screen is that committing a cycle freezes the
 * scope denominator.** `POST .../commit` snapshots `committedCount` and every
 * later addition or removal is *appended* to `scopeChanges` with a reason
 * instead of silently redefining the count. So:
 *
 *  - The denominator is displayed as a **stored** value with the moment it was
 *    taken (`committedAt`), not as a live recount. "Delivered 3 of 10 committed"
 *    stays true after scope changes, which is the entire point.
 *  - **Every scope change on this screen requires a reason**, because the
 *    server requires one. There is no path in this UI that edits the
 *    denominator quietly: adding an item to a committed cycle, or removing one,
 *    opens a dialog that states the effect and asks why.
 *  - The `scopeChanges` history is rendered in full, with who and when. It is
 *    the record that makes the frozen number honest, so it is not tucked away.
 *
 * Cancelling an item is a different operation from removing it, and the
 * difference is stated where the control is: a cancelled item leaves the
 * numerator but stays inside the frozen denominator, which is why the server
 * offers cancel-instead-of-delete once a cycle is committed.
 */
type ViewState = { view: string };

const VIEW_DEFAULTS: ViewState = { view: 'board' };

/** The board's columns, in the order work moves through §8.2. */
const BOARD_COLUMNS: WorkItemStatus[] = ['backlog', 'committed', 'active', 'review', 'blocked', 'verified'];

export default function CycleBoardPage() {
  const params = useParams<{ projectId: string; cycleId: string }>();
  const projectId = params.projectId;
  const cycleId = params.cycleId;
  const router = useRouter();
  const [view, setView] = useUrlState<ViewState>(VIEW_DEFAULTS);

  const [cycle, setCycle] = useState<CycleDetail | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [commitOpen, setCommitOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [addTitle, setAddTitle] = useState('');
  const [addCategory, setAddCategory] = useState<WorkCategory>('fix');
  const [addDiscipline, setAddDiscipline] = useState<WorkDiscipline>('technical');
  const [addPriority, setAddPriority] = useState<WorkPriority>('medium');
  const [addDueOn, setAddDueOn] = useState('');
  const [addStatus, setAddStatus] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  /** Reason collected for whichever scope change is pending. */
  const [pendingRemoval, setPendingRemoval] = useState<WorkItem | null>(null);
  const [scopeReason, setScopeReason] = useState('');
  const [scopeError, setScopeError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const detail = await getCycleDetail(projectId, cycleId, { signal });
      setCycle(detail);
    },
    [projectId, cycleId],
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

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const project = await getProject(projectId, { signal: controller.signal });
        setProjectName(project.name);
      } catch {
        /* context only */
      }
    })();
    return () => controller.abort();
  }, [projectId]);

  const items = useMemo(() => cycle?.workItems ?? [], [cycle]);

  const committed = Boolean(cycle?.committedAt);
  const deliveredCount = items.filter((item) => item.status === 'verified').length;
  const activeCount = items.filter((item) => item.status === 'active').length;
  const cancelledCount = items.filter((item) => item.status === 'cancelled').length;

  /** The shared `@/types` work-item view model the Work* patterns render. */
  const toListItems = useCallback(
    (rows: readonly WorkItem[]): WorkListItem[] =>
      rows.map((row) => ({
        id: row.id,
        deliverable: row.title,
        owner: row.assigneeId ? 'Assigned' : 'Unassigned',
        dueDate: row.dueAt ?? undefined,
        status: toViewStatus(row.status),
        // The blocker is on this DTO, so it is shown rather than omitted.
        blocker: row.status === 'blocked' ? (row.blockedReason ?? 'Blocked — no reason recorded') : undefined,
        evidenceHref: undefined,
        nextAction: row.status === 'blocked' && row.blockedOn ? `Waiting on ${row.blockedOn}` : undefined,
      })),
    [],
  );

  async function onCommit(note: string) {
    await commitCycle(projectId, cycleId, note || undefined);
    setCommitOpen(false);
    setNotice('Cycle committed. Its scope is now frozen.');
    await load();
  }

  async function onAdvance(to: CycleStatus) {
    setAdvanceError(null);
    try {
      await setCycleStatus(projectId, cycleId, to as Exclude<CycleStatus, 'committed'>);
      setNotice(`Cycle moved to ${to}.`);
      await load();
    } catch (caught) {
      setAdvanceError(toApiError(caught).message);
    }
  }

  async function onAddWork(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!addTitle.trim()) {
      setAddError('Give the work item a title.');
      return;
    }
    setAddStatus(null);
    setAddError(null);
    try {
      if (committed) {
        // Adding to a committed cycle is a scope change and needs a reason —
        // the server refuses it otherwise, and the reason is what gets recorded.
        if (!scopeReason.trim()) {
          setAddError(
            'This cycle is committed. Adding work changes its committed scope, so a reason is required.',
          );
          return;
        }
      }
      await createWorkItem(projectId, {
        title: addTitle.trim(),
        category: addCategory,
        discipline: addDiscipline,
        priority: addPriority,
        cycleId,
        dueOn: addDueOn || undefined,
        scopeChangeReason: committed ? scopeReason.trim() : undefined,
      });
      setAddStatus(
        committed
          ? 'Work added. The scope change was recorded with your reason; the committed count is unchanged.'
          : 'Work added to the planning cycle.',
      );
      setAddTitle('');
      setAddDueOn('');
      setScopeReason('');
      await load();
    } catch (caught) {
      setAddError(toApiError(caught).message);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Project', href: `/projects/${projectId}` }]}
          title="Cycle"
        />
        <ErrorState error={error} notFoundReason="missing-or-private" onRetry={() => void load()} />
      </div>
    );
  }

  if (!cycle) return null;

  const status = cycle.status as CycleStatus;
  const nextStates = (CYCLE_TRANSITIONS[status] ?? []).filter((next) => next !== 'committed');

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(projectName ? [{ label: projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Cycle board' },
        ]}
        title={cycle.name}
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <Timestamp value={cycle.startsOn} dateOnly /> –{' '}
              <Timestamp value={cycle.endsOn} dateOnly />
            </span>
            {cycle.goal ? <span className="text-muted-foreground">{cycle.goal}</span> : null}
          </span>
        }
        status={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill tone={cycleStatusTone(status)} label={cycleStatusLabel(status)} />
            {committed ? (
              <StatusPill tone="info" label="Scope frozen" />
            ) : (
              <StatusPill tone="unmeasured" label="Scope not frozen" />
            )}
          </span>
        }
        primaryAction={
          status === 'planning'
            ? {
                label: 'Commit this cycle',
                onClick: () => setCommitOpen(true),
                disabled: items.length === 0,
                disabledReason:
                  items.length === 0
                    ? 'A cycle with no work items has nothing to commit.'
                    : undefined,
              }
            : nextStates.length > 0
              ? {
                  label: `Move to ${cycleStatusLabel(nextStates[0])}`,
                  onClick: () =>
                    nextStates[0] === 'closed' ? setCloseOpen(true) : void onAdvance(nextStates[0]),
                }
              : undefined
        }
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}/cycles`}>All cycles</Link>
          </Button>
        }
      />

      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {advanceError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>The cycle did not move</AlertTitle>
          <AlertDescription>{advanceError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">
            {committed ? 'Committed scope' : 'Scope'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {committed ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Figure
                  label="Committed at commit"
                  value={cycle.committedCount}
                  note={
                    cycle.committedAt ? (
                      <>
                        Frozen <Timestamp value={cycle.committedAt} />
                      </>
                    ) : undefined
                  }
                />
                <Figure
                  label="Delivered (verified)"
                  value={deliveredCount}
                  unit={`of ${formatNumber(cycle.committedCount)}`}
                  note="Verified work only — submitted or in-review work has not been accepted yet."
                />
                <Figure
                  label="Items in the cycle now"
                  value={items.filter((item) => item.status !== 'cancelled').length}
                  note={`${formatNumber(cancelledCount)} cancelled item${cancelledCount === 1 ? '' : 's'} excluded. This is not the denominator.`}
                />
              </div>

              <p className="text-table text-muted-foreground">
                The denominator is the count stored at commit time. It does not move when scope
                changes, which is what keeps &ldquo;{formatNumber(deliveredCount)} of{' '}
                {formatNumber(cycle.committedCount)} committed&rdquo; true afterwards. Every change
                since the commit is listed below with its reason.
              </p>
            </>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Figure
                  label="Items in the cycle"
                  value={items.filter((item) => item.status !== 'cancelled').length}
                  note="Nothing is frozen yet. Committing snapshots this number."
                />
                <Figure
                  label="Active now"
                  value={activeCount}
                  note="Work started before commitment is not a scope change — it is the same scope, moving."
                />
              </div>
              <p className="text-table text-muted-foreground">
                Committing freezes the count above, moves every backlog item to committed, and
                records the commitment. It is refused if the funding engagement is paused, because
                pausing is meant to stop new commitments rather than accept them.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {cycle.scopeChanges.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Scope changes since the commit</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="divide-y divide-border">
              {[...cycle.scopeChanges].reverse().map((change, index) => (
                <li key={`${change.at}-${index}`} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-table">
                    <StatusPill
                      tone="warning"
                      label={
                        change.added.length > 0 && change.removed.length > 0
                          ? 'Added and removed'
                          : change.added.length > 0
                            ? 'Added'
                            : 'Removed'
                      }
                    />
                    <Timestamp value={change.at} />
                    <span className="text-meta text-muted-foreground">
                      by <span className="font-mono">{change.by}</span>
                    </span>
                  </div>
                  <p className="text-table">{change.reason}</p>
                  <p className="text-meta text-muted-foreground">
                    {change.added.length > 0
                      ? `${formatNumber(change.added.length)} item${change.added.length === 1 ? '' : 's'} added`
                      : ''}
                    {change.added.length > 0 && change.removed.length > 0 ? ' · ' : ''}
                    {change.removed.length > 0
                      ? `${formatNumber(change.removed.length)} removed`
                      : ''}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : committed ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-table text-muted-foreground">
              No scope changes have been recorded since this cycle was committed. The committed
              count above and the items below agree.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Tabs value={view.view} onValueChange={(value) => setView({ view: value })}>
        <TabsList>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="list">List</TabsTrigger>
          <TabsTrigger value="add">Add work</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="pt-4">
          {items.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <EmptyState
                  variant="not-measured"
                  subject="work items in this cycle"
                  prerequisite="work scoped into this cycle before it can be committed"
                  action={{ label: 'Add work', onClick: () => setView({ view: 'add' }) }}
                  layout="panel"
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-3 xl:grid-cols-6">
              {BOARD_COLUMNS.map((column) => {
                const columnItems = items.filter((item) => item.status === column);
                return (
                  <section key={column} className="space-y-3">
                    <h2 className="flex items-center justify-between gap-2 text-table font-semibold">
                      {WORK_ITEM_STATUS_LABEL[column]}
                      <span className="text-meta font-normal text-muted-foreground">
                        {formatNumber(columnItems.length)}
                      </span>
                    </h2>
                    {columnItems.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border p-3 text-meta text-muted-foreground">
                        Nothing in {WORK_ITEM_STATUS_LABEL[column].toLowerCase()}.
                      </p>
                    ) : (
                      <ul className="space-y-3">
                        {columnItems.map((item) => (
                          <li key={item.id}>
                            <WorkCard
                              item={toListItems([item])[0]}
                              onOpen={() => router.push(`/projects/${projectId}/work/${item.id}`)}
                              actions={
                                item.cycleId ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setPendingRemoval(item);
                                      setScopeReason('');
                                      setScopeError(null);
                                    }}
                                  >
                                    Remove
                                  </Button>
                                ) : null
                              }
                            />
                            <p className="mt-1 px-1 text-meta text-muted-foreground">
                              {WORK_CATEGORY_LABEL[item.category as WorkCategory] ?? item.category} ·{' '}
                              {WORK_DISCIPLINE_LABEL[item.discipline as WorkDiscipline] ?? item.discipline} ·{' '}
                              {WORK_PRIORITY_LABEL[item.priority as WorkPriority] ?? item.priority}
                              {item.clientVisible ? ' · client-visible' : ' · internal'}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="list" className="pt-4">
          <WorkList
            items={toListItems(items)}
            onOpen={(item) => router.push(`/projects/${projectId}/work/${item.id}`)}
            label={`Work items in ${cycle.name}`}
            caption={
              <>
                {formatNumber(items.length)} item{items.length === 1 ? '' : 's'} in this cycle. The
                table shows the collapsed work status; the board above keeps the lifecycle states
                distinct.
              </>
            }
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="work items in this cycle"
                prerequisite="work scoped into this cycle"
                layout="panel"
              />
            }
          />
        </TabsContent>

        <TabsContent value="add" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Add work to this cycle</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={onAddWork} noValidate className="space-y-4">
                {committed ? (
                  <Alert>
                    <AlertTitle>This cycle is committed</AlertTitle>
                    <AlertDescription>
                      Adding work here does not change the committed count — it appends a scope
                      change with your reason, so the delivered/committed ratio stays comparable.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {addError ? (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{addError}</AlertDescription>
                  </Alert>
                ) : null}
                {addStatus ? (
                  <Alert>
                    <AlertDescription>{addStatus}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-1.5">
                  <Label htmlFor="addTitle">
                    Title
                    <span className="ml-1 text-meta font-normal text-muted-foreground">
                      (required)
                    </span>
                  </Label>
                  <Input
                    id="addTitle"
                    value={addTitle}
                    onChange={(event) => setAddTitle(event.target.value)}
                    required
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="addCategory">Category</Label>
                    <select
                      id="addCategory"
                      value={addCategory}
                      onChange={(event) => setAddCategory(event.target.value as WorkCategory)}
                      className="h-9 w-full rounded-md border border-input bg-surface px-3 text-table shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {WORK_CATEGORIES.map((value) => (
                        <option key={value} value={value}>
                          {WORK_CATEGORY_LABEL[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="addDiscipline">Discipline</Label>
                    <select
                      id="addDiscipline"
                      value={addDiscipline}
                      onChange={(event) => setAddDiscipline(event.target.value as WorkDiscipline)}
                      className="h-9 w-full rounded-md border border-input bg-surface px-3 text-table shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {Object.entries(WORK_DISCIPLINE_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="addPriority">Priority</Label>
                    <select
                      id="addPriority"
                      value={addPriority}
                      onChange={(event) => setAddPriority(event.target.value as WorkPriority)}
                      className="h-9 w-full rounded-md border border-input bg-surface px-3 text-table shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {WORK_PRIORITIES.map((value) => (
                        <option key={value} value={value}>
                          {WORK_PRIORITY_LABEL[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="addDueOn">Due date</Label>
                  <Input
                    id="addDueOn"
                    type="date"
                    value={addDueOn}
                    onChange={(event) => setAddDueOn(event.target.value)}
                  />
                  <p className="text-meta text-muted-foreground">
                    Resolved end-of-day by the server, in this project&apos;s engagement timezone —
                    never against your browser clock.
                  </p>
                </div>

                {committed ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="scopeReason">
                      Reason for the scope change
                      <span className="ml-1 text-meta font-normal text-muted-foreground">
                        (required)
                      </span>
                    </Label>
                    <Textarea
                      id="scopeReason"
                      value={scopeReason}
                      onChange={(event) => setScopeReason(event.target.value)}
                      rows={3}
                      required
                    />
                    <p className="text-meta text-muted-foreground">
                      Recorded verbatim in the cycle&apos;s scope-change history with your name and
                      the time. There is no way to change the frozen count itself.
                    </p>
                  </div>
                ) : null}

                <Button type="submit">Add to cycle</Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={commitOpen}
        onOpenChange={setCommitOpen}
        title="Commit this cycle"
        confirmLabel="Commit cycle"
        targetLabel="Cycle"
        target={cycle.name}
        effect={
          <>
            <p>
              {formatNumber(items.filter((item) => item.status !== 'cancelled').length)} work item
              {items.filter((item) => item.status !== 'cancelled').length === 1 ? '' : 's'} become
              the <strong className="font-medium">committed scope</strong>. Every backlog item moves
              to committed.
            </p>
          </>
        }
        scope={
          <>
            The count is frozen at this moment. Adding or removing work afterwards is recorded as a
            scope change with a reason rather than changing the denominator, and this cannot be
            undone — a committed cycle cannot return to planning.
          </>
        }
        onConfirm={() => onCommit('')}
      />

      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title="Close this cycle"
        confirmLabel="Close cycle"
        targetLabel="Cycle"
        target={cycle.name}
        effect="The cycle moves to closed. No further work can be attached to it, and its scope can no longer change."
        scope="The work items themselves are unaffected — only the cycle stops accepting changes. A closed cycle cannot be edited."
        onConfirm={async () => {
          await onAdvance('closed');
        }}
        onConfirmed={() => setCloseOpen(false)}
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title="Remove work from this cycle"
        confirmLabel="Remove from cycle"
        targetLabel="Work item"
        target={pendingRemoval?.title}
        effect={
          <>
            The item leaves this cycle and returns to the project backlog.{' '}
            {committed
              ? 'Because the cycle is committed, the removal is recorded as a scope change with your reason — the frozen committed count does not change.'
              : 'The cycle is not committed, so this is an ordinary edit with nothing to record.'}
          </>
        }
        scope="The work item is not cancelled or deleted. Its history, evidence and any verification stay with it."
        onConfirm={async () => {
          if (!pendingRemoval) return;
          if (committed && !scopeReason.trim()) {
            setScopeError(
              'A reason is required: this cycle is committed, so removing work changes its scope.',
            );
            throw new Error('Reason required');
          }
          try {
            await updateWorkItem(projectId, pendingRemoval.id, {
              cycleId: '',
              scopeChangeReason: committed ? scopeReason.trim() : undefined,
            });
          } catch (caught) {
            throw caught;
          }
        }}
        onConfirmed={() => {
          setPendingRemoval(null);
          setScopeReason('');
          setScopeError(null);
          setNotice('Work removed from the cycle.');
          void load();
        }}
        onReload={() => void load()}
      >
        {committed ? (
          <div className="space-y-1.5">
            <Label htmlFor="removalReason">
              Reason for the scope change
              <span className="ml-1 text-meta font-normal text-muted-foreground">(required)</span>
            </Label>
            <Textarea
              id="removalReason"
              value={scopeReason}
              onChange={(event) => setScopeReason(event.target.value)}
              rows={3}
              required
            />
            {scopeError ? (
              <p className="text-meta text-danger-foreground" role="alert">
                {scopeError}
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function Figure({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: number;
  unit?: string;
  note?: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-meta text-muted-foreground">{label}</p>
      <p className="text-kpi font-semibold tabular-nums">
        {formatNumber(value)}
        {unit ? <span className="ml-1 text-table font-normal text-muted-foreground">{unit}</span> : null}
      </p>
      {note ? <p className="text-meta text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** The five-state view model, mapped from the seven-state lifecycle. */
function toViewStatus(status: string): WorkListItem['status'] {
  switch (status) {
    case 'active':
      return 'in-progress';
    case 'review':
      return 'in-review';
    case 'blocked':
      return 'blocked';
    case 'verified':
      return 'done';
    // Cancelled work was not delivered, so it never reads as done.
    case 'cancelled':
    case 'backlog':
    case 'committed':
    default:
      return 'not-started';
  }
}

function cycleStatusLabel(status: CycleStatus): string {
  return { planning: 'Planning', committed: 'Committed', active: 'Active', review: 'Review', closed: 'Closed' }[
    status
  ];
}

function cycleStatusTone(status: CycleStatus): 'neutral' | 'info' | 'warning' | 'success' | 'unmeasured' {
  switch (status) {
    case 'planning':
      return 'unmeasured';
    case 'committed':
      return 'info';
    case 'active':
      return 'info';
    case 'review':
      return 'warning';
    case 'closed':
      return 'neutral';
  }
}
