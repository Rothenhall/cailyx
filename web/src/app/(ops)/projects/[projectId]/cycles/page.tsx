'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { cycleStatusLabel, cycleStatusTone } from '@/lib/status-tones';
import {
  assignToPhase,
  createCycle,
  createPhase,
  listCycles,
  listPhases,
  removeFromPhase,
  SUGGESTED_PHASE_NAMES,
  type Cycle,
  type Phase,
} from '@/services/delivery-plan';

/**
 * C3, Option B (docs/analysis/engagement-timeline.md §2) — one phase's row in
 * the phases panel: its own record plus which of the project's cycles are
 * currently assigned to it. Assignment is per-cycle (each cycle picks its
 * phase from a dropdown in the table below), not drag-and-drop, matching the
 * plain form-driven pattern already used for creating a cycle on this screen.
 */
function PhasesPanel({
  projectId,
  phases,
  onCreated,
}: {
  projectId: string;
  phases: Phase[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createPhase(projectId, { name: name.trim() });
      setName('');
      onCreated();
    } catch (caught) {
      setCreateError(toApiError(caught).message);
    } finally {
      setCreating(false);
    }
  }

  const unusedSuggestions = SUGGESTED_PHASE_NAMES.filter(
    (suggestion) => !phases.some((phase) => phase.name.toLowerCase() === suggestion.toLowerCase()),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Phases</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-table text-muted-foreground">
          Client-facing stages of the engagement, shown in the client portal grouped with their
          assigned cycles and 30-day-plan commitments. A phase carries no status logic of its own —
          it is a label only. Assign a cycle to one from the table below.
        </p>

        {phases.length === 0 ? (
          <EmptyState variant="no-records" subject="phases" />
        ) : (
          <ol className="space-y-1.5">
            {phases.map((phase) => (
              <li
                key={phase.id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <span className="text-table font-medium">{phase.name}</span>
                <StatusPill
                  tone={phase.status === 'active' ? 'info' : phase.status === 'complete' ? 'success' : 'neutral'}
                  label={phase.status.charAt(0).toUpperCase() + phase.status.slice(1)}
                />
              </li>
            ))}
          </ol>
        )}

        <form onSubmit={onCreate} noValidate className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label htmlFor="phase-name">New phase name</Label>
            <Input
              id="phase-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={creating}
              placeholder="e.g. Diagnose"
            />
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            {creating ? 'Adding…' : 'Add phase'}
          </Button>
        </form>

        {unusedSuggestions.length > 0 ? (
          <p className="text-meta text-muted-foreground">
            Suggested (Rothenhall&apos;s own stage names — optional, rename or skip freely):{' '}
            {unusedSuggestions.map((suggestion, index) => (
              <span key={suggestion}>
                <button
                  type="button"
                  className="underline underline-offset-4 hover:text-foreground"
                  onClick={() => setName(suggestion)}
                >
                  {suggestion}
                </button>
                {index < unusedSuggestions.length - 1 ? ', ' : ''}
              </span>
            ))}
          </p>
        ) : null}

        {createError ? (
          <p role="alert" className="text-table text-danger-foreground">
            {createError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * PJ08 — Cycle board, index.
 *
 * design_plan.md §4.3 specifies the cycle board only at `/cycles/:cycleId` —
 * there is no listed index screen. But `/cycles` (no id) is exactly what the
 * §2.3 project nav links to under "Plan & Work", and there was previously
 * nothing built at that path, so the nav item 404'd. This screen is the
 * missing middle step: it lists the project's cycles and is where a cycle
 * gets created in the first place, since nothing elsewhere in the app called
 * `createCycle` either.
 *
 * A cycle here is always shown by its **stored** status, never a computed
 * one — see the cycle detail screen for why `committedCount` is a frozen
 * snapshot rather than a live recount. This list does not attempt to
 * reproduce that arithmetic; it only routes to the screen that shows it.
 */
export default function CyclesIndexPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const [cycles, setCycles] = useState<Cycle[] | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [assigningCycleId, setAssigningCycleId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [goal, setGoal] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const [cycleResult, phaseResult] = await Promise.all([
        listCycles(projectId, undefined, { signal }),
        // Phases are optional (many projects will have none) — a failed read
        // must not blank the cycle board, which is this screen's primary job.
        listPhases(projectId, { signal }).catch(() => []),
      ]);
      setCycles(cycleResult);
      setPhases(phaseResult);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, [projectId]);

  async function onAssignPhase(cycleId: string, phaseId: string) {
    setAssigningCycleId(cycleId);
    setAssignError(null);
    try {
      if (phaseId === '__none__') {
        await removeFromPhase(projectId, { cycleId });
      } else {
        await assignToPhase(projectId, phaseId, { cycleId });
      }
      await load();
    } catch (caught) {
      setAssignError(toApiError(caught).message);
    } finally {
      setAssigningCycleId(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function resetForm() {
    setName('');
    setStartsOn('');
    setEndsOn('');
    setGoal('');
    setCreateError(null);
  }

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    if (!name.trim() || !startsOn || !endsOn) {
      setCreateError('Name, start date and end date are all required.');
      return;
    }
    if (endsOn < startsOn) {
      setCreateError('The end date cannot be before the start date.');
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const created = await createCycle(projectId, {
        name: name.trim(),
        startsOn,
        endsOn,
        goal: goal.trim() || undefined,
      });
      setCreateOpen(false);
      resetForm();
      // Straight to the board — a freshly created cycle has nothing to list
      // here yet, and the operator's next action is always adding work to it.
      router.push(`/projects/${projectId}/cycles/${created.id}`);
    } catch (caught) {
      setCreateError(toApiError(caught).message);
    } finally {
      setCreating(false);
    }
  }

  const columns = useMemo<ReadonlyArray<ColumnDef<Cycle>>>(
    () => [
      {
        key: 'name',
        header: 'Cycle',
        accessor: (row) => row.name,
        sortable: true,
        render: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        sortable: true,
        width: 130,
        render: (row) => <StatusPill label={cycleStatusLabel(row.status)} tone={cycleStatusTone(row.status)} />,
      },
      {
        key: 'window',
        header: 'Window',
        accessor: (row) => row.startsOn,
        sortable: true,
        sortValue: (row) => row.startsOn,
        render: (row) => (
          <span className="whitespace-nowrap text-table">
            <Timestamp value={row.startsOn} dateOnly /> – <Timestamp value={row.endsOn} dateOnly />
          </span>
        ),
      },
      {
        key: 'committedCount',
        header: 'Committed',
        accessor: (row) => row.committedCount,
        sortable: true,
        align: 'right',
        width: 110,
        // §3.5 — a cycle still in planning has never had a scope frozen; that
        // is not the same as a committed cycle with zero items.
        emptyLabel: 'Not committed',
        render: (row) => (row.committedAt ? String(row.committedCount) : null),
      },
      {
        key: 'goal',
        header: 'Goal',
        accessor: (row) => row.goal,
        render: (row) => <span className="truncate text-muted-foreground">{row.goal ?? ''}</span>,
      },
      {
        key: 'phase',
        header: 'Phase',
        accessor: (row) => phases.find((phase) => phase.id === row.phaseId)?.name ?? '',
        width: 180,
        // C3, Option B — assignment is a label only: changing it never touches
        // the cycle's own status/commit state above. Stops propagation so
        // picking a phase does not also navigate the row into the cycle
        // detail screen.
        render: (row) => (
          <div onClick={(event) => event.stopPropagation()}>
            <Select
              value={row.phaseId ?? '__none__'}
              onValueChange={(value) => void onAssignPhase(row.id, value)}
              disabled={assigningCycleId === row.id || phases.length === 0}
            >
              <SelectTrigger className="h-8 text-meta">
                <SelectValue placeholder={phases.length === 0 ? 'No phases yet' : 'Unphased'} />
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
        ),
      },
    ],
    [phases, assigningCycleId],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Project', href: `/projects/${projectId}` }]}
        title="Cycle board"
        context="Time-boxed batches of committed work — the cycle detail screen holds the board itself."
        primaryAction={{ label: 'New cycle', onClick: () => setCreateOpen(true) }}
      />

      {error ? (
        <ErrorState error={error} notFoundReason="missing-or-private" onRetry={() => void load()} />
      ) : (
        <>
          <PhasesPanel projectId={projectId} phases={phases} onCreated={() => void load()} />

          {assignError ? (
            <p role="alert" className="text-table text-danger-foreground">
              {assignError}
            </p>
          ) : null}

          {cycles === null ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : cycles.length === 0 ? (
            <EmptyState
              variant="no-records"
              subject="cycles"
              action={{ label: 'Start the first cycle', onClick: () => setCreateOpen(true) }}
            />
          ) : (
            <DataTable<Cycle>
              columns={columns}
              rows={cycles}
              getRowId={(row) => row.id}
              caption="Project cycles"
              defaultSort={{ key: 'window', direction: 'desc' }}
              rowHref={(row) => `/projects/${projectId}/cycles/${row.id}`}
              linkColumnKey="name"
              emptyState={<EmptyState variant="no-results" />}
            />
          )}
        </>
      )}

      <Sheet
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetForm();
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto bg-surface sm:max-w-lg">
          <SheetHeader className="space-y-2 text-left">
            <SheetTitle>New cycle</SheetTitle>
            <SheetDescription className="text-table text-muted-foreground">
              A cycle starts in planning. Nothing is committed until the cycle detail screen freezes its
              scope — creating it here does not lock anything in.
            </SheetDescription>
          </SheetHeader>

          <form onSubmit={onCreate} noValidate className="mt-5 space-y-4">
            {createError ? (
              <p role="alert" className="text-table text-danger-foreground">
                {createError}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="cycle-name">Name</Label>
              <Input
                id="cycle-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                required
                disabled={creating}
                placeholder="e.g. Sprint 14"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cycle-starts">Starts</Label>
                <Input
                  id="cycle-starts"
                  type="date"
                  value={startsOn}
                  onChange={(event) => setStartsOn(event.target.value)}
                  required
                  disabled={creating}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cycle-ends">Ends</Label>
                <Input
                  id="cycle-ends"
                  type="date"
                  value={endsOn}
                  onChange={(event) => setEndsOn(event.target.value)}
                  required
                  disabled={creating}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cycle-goal">
                Goal
                <span className="ml-1 text-meta font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="cycle-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                disabled={creating}
                rows={3}
              />
            </div>

            <Button type="submit" className="w-full" disabled={creating}>
              {creating ? 'Creating…' : 'Create cycle'}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
