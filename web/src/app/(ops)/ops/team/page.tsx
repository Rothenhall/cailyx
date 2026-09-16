'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import {
  ABSENCE_KIND_LABEL,
  listTeamCapacity,
  listTeamMembers,
  OPERATOR_ROLE_LABEL,
  type CapacityAllocation,
  type TeamMember,
} from '@/services/delivery-plan';

/**
 * OP12 — Team capacity.
 *
 * design_plan.md §4.2: *"People by role, allocated hours, leave, cycles,
 * overloaded handoffs"*, support "N G06; user admin list is not capacity
 * data".
 *
 * That last clause is the design instruction for this page, and it cuts two
 * ways:
 *
 *  - **The directory is not capacity.** `GET /users` says who exists and what
 *    role they hold. It says nothing about whether they are available, so the
 *    two reads are kept visibly separate: the directory annotates the rows,
 *    and the totals come only from the capacity ledger.
 *  - **The directory is admin-only.** `GET /users` is `@Roles('admin')` at the
 *    class level and no role-scoped directory exists yet (G03). A non-admin
 *    therefore gets a 403 on a screen whose *capacity* data they are allowed to
 *    read. That is handled as its own state: the allocations still render, and
 *    the missing names are explained rather than shown as an empty team.
 *
 * §7.5's capacity definition is what the overload marker encodes: *"Capacity =
 * available hours − leave − fixed service duties − review/incident reserve"*.
 * Leave arrives in this ledger as an allocation with an `absenceKind`, so a
 * person's available hours already have it accounted for where it was recorded
 * — the screen does not subtract it a second time. What it does do is
 * distinguish the three cases a reader has to act on differently: **over
 * capacity**, **no hours recorded at all** (which is not the same fact as zero
 * capacity), and **on leave**.
 */

type Filters = {
  q: string;
  role: string;
  scope: string;
  absence: string;
  from: string;
  to: string;
};

/** A module constant, so `FilterBar` can tell what "filtered" means. */
const FILTER_DEFAULTS: Filters = {
  q: '',
  role: FILTER_ALL,
  scope: FILTER_ALL,
  absence: FILTER_ALL,
  from: '',
  to: '',
};

interface AllocationRow extends CapacityAllocation {
  personName: string | null;
  personRole: string | null;
  /** Sum of the allocations shown for this person, across the loaded rows. */
  personAvailable: number;
  personAllocated: number;
  personAllocationCount: number;
  /** allocated − available, when positive. Negative means headroom. */
  overBy: number;
}

/**
 * `useUrlState` reads `useSearchParams`, which suspends during a static
 * prerender. The boundary is here, outside the component that calls the hook,
 * so the route builds as client-rendered instead of failing the export.
 */
export default function TeamCapacityPage() {
  return (
    <Suspense fallback={<CapacitySkeleton />}>
      <TeamCapacityView />
    </Suspense>
  );
}

function CapacitySkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

function TeamCapacityView() {
  const [filters, setFilters] = useUrlState<Filters>(FILTER_DEFAULTS);

  const [allocations, setAllocations] = useState<CapacityAllocation[] | null>(null);
  /** Server-summed across exactly the rows it returned. */
  const [totals, setTotals] = useState<{
    availableHours: number;
    allocatedHours: number;
    remainingHours: number;
  } | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [membersError, setMembersError] = useState<ReturnType<typeof toApiError> | null>(null);

  const query = useMemo(
    () => ({ from: filters.from || undefined, to: filters.to || undefined }),
    [filters.from, filters.to],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setLoading(true);
        const view = await listTeamCapacity(query, { signal });
        setAllocations(view.allocations);
        setTotals({
          availableHours: view.availableHours,
          allocatedHours: view.allocatedHours,
          remainingHours: view.remainingHours,
        });
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await listTeamMembers({ signal: controller.signal });
        setMembers(rows.filter((row) => row.type !== 'client'));
        setMembersError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setMembersError(toApiError(caught));
      }
    })();
    return () => controller.abort();
  }, []);

  /** userId → member, for annotating rows without a per-row lookup. */
  const memberById = useMemo(() => {
    const map = new Map<string, TeamMember>();
    for (const member of members ?? []) map.set(member.id, member);
    return map;
  }, [members]);

  /**
   * Per-person roll-up and the overload flag.
   *
   * Summed over the rows this read returned — which is the complete matching
   * set, because the endpoint does not paginate. The table says so, so the
   * number is never mistaken for a portfolio-wide total computed from a page.
   */
  const rows: AllocationRow[] = useMemo(() => {
    const list = allocations ?? [];
    const perPerson = new Map<string, { available: number; allocated: number; count: number }>();
    for (const allocation of list) {
      const bucket = perPerson.get(allocation.userId) ?? { available: 0, allocated: 0, count: 0 };
      bucket.available += allocation.availableHours;
      bucket.allocated += allocation.allocatedHours;
      bucket.count += 1;
      perPerson.set(allocation.userId, bucket);
    }

    return list.map((allocation) => {
      const bucket = perPerson.get(allocation.userId) ?? {
        available: 0,
        allocated: 0,
        count: 0,
      };
      const member = memberById.get(allocation.userId);
      return {
        ...allocation,
        personName: member?.name ?? null,
        personRole: member?.role ?? null,
        personAvailable: bucket.available,
        personAllocated: bucket.allocated,
        personAllocationCount: bucket.count,
        overBy: bucket.allocated - bucket.available,
      };
    });
  }, [allocations, memberById]);

  /** Distinct people whose total allocation exceeds their total availability. */
  const overloaded = useMemo(() => {
    const seen = new Map<string, AllocationRow>();
    for (const row of rows) {
      if (row.overBy > 0 && !seen.has(row.userId)) seen.set(row.userId, row);
    }
    return [...seen.values()].sort((a, b) => b.overBy - a.overBy);
  }, [rows]);

  const leaveRows = useMemo(
    () => (allocations ?? []).filter((row) => Boolean(row.absenceKind)),
    [allocations],
  );

  const cycleIds = useMemo(
    () => new Set((allocations ?? []).map((row) => row.cycleId).filter((id): id is string => Boolean(id))),
    [allocations],
  );

  /** Filters that the table can apply locally, over the rows already loaded. */
  const filteredRows = useMemo(() => {
    const search = filters.q.trim().toLowerCase();
    return rows.filter((row) => {
      if (filters.role !== FILTER_ALL && (row.personRole ?? 'unknown') !== filters.role) return false;
      if (filters.scope === 'project' && !row.projectId) return false;
      if (filters.scope === 'org' && row.projectId) return false;
      if (filters.absence === 'none' && row.absenceKind) return false;
      if (
        filters.absence !== FILTER_ALL &&
        filters.absence !== 'none' &&
        row.absenceKind !== filters.absence
      ) {
        return false;
      }
      if (search) {
        const haystack = [
          row.personName ?? '',
          row.userId,
          row.projectId ?? '',
          row.cycleId ?? '',
          row.note ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }, [rows, filters]);

  const isFiltered =
    filters.role !== FILTER_ALL ||
    filters.scope !== FILTER_ALL ||
    filters.absence !== FILTER_ALL ||
    filters.q.trim() !== '';

  const columns: ColumnDef<AllocationRow>[] = [
    {
      key: 'person',
      header: 'Person',
      accessor: (row) => row.personName ?? row.userId,
      sortable: true,
      render: (row) =>
        row.personName ? (
          <span className="font-medium">{row.personName}</span>
        ) : (
          // §3.5 — an unresolvable name is stated, not rendered blank.
          <span className="text-muted-foreground">
            {row.userId}
            <span className="ml-1 text-meta">(name unavailable)</span>
          </span>
        ),
      searchText: (row) => `${row.personName ?? ''} ${row.userId}`,
    },
    {
      key: 'role',
      header: 'Role',
      accessor: (row) => row.personRole,
      sortable: true,
      emptyLabel: 'Role not readable',
      render: (row) =>
        row.personRole ? (
          OPERATOR_ROLE_LABEL[row.personRole] ?? row.personRole
        ) : (
          <span className="text-meta text-muted-foreground">Role not readable</span>
        ),
    },
    {
      key: 'scope',
      header: 'Allocation',
      accessor: (row) => (row.projectId ? 'project' : 'org'),
      sortable: true,
      render: (row) =>
        row.projectId ? (
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/projects/${row.projectId}`} className="underline underline-offset-4">
              Project
            </Link>
            {row.cycleId ? (
              <span className="text-meta text-muted-foreground">
                cycle <span className="font-mono">{row.cycleId}</span>
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">Not project-specific</span>
        ),
      searchText: (row) => `${row.projectId ?? ''} ${row.cycleId ?? ''}`,
    },
    {
      key: 'period',
      header: 'Period',
      accessor: (row) => row.startsOn,
      sortable: true,
      sortValue: (row) => row.startsOn,
      render: (row) => (
        <span className="whitespace-nowrap">
          <Timestamp value={row.startsOn} dateOnly /> –{' '}
          <Timestamp value={row.endsOn} dateOnly />
        </span>
      ),
    },
    {
      key: 'availableHours',
      header: 'Available',
      accessor: (row) => row.availableHours,
      sortable: true,
      align: 'right',
      render: (row) => `${formatNumber(row.availableHours)} h`,
    },
    {
      key: 'allocatedHours',
      header: 'Allocated',
      accessor: (row) => row.allocatedHours,
      sortable: true,
      align: 'right',
      render: (row) => `${formatNumber(row.allocatedHours)} h`,
    },
    {
      key: 'personTotal',
      header: 'Person total',
      accessor: (row) => row.personAllocated,
      sortable: true,
      align: 'right',
      render: (row) => (
        <span className="whitespace-nowrap">
          {formatNumber(row.personAllocated)} h of {formatNumber(row.personAvailable)} h
          <span className="block text-meta text-muted-foreground">
            across {formatNumber(row.personAllocationCount)} allocation
            {row.personAllocationCount === 1 ? '' : 's'}
          </span>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      accessor: (row) => (row.overBy > 0 ? 'over' : row.absenceKind ? 'leave' : 'within'),
      sortable: true,
      render: (row) => {
        if (row.overBy > 0) {
          // Over capacity is a commitment that cannot be met, so it is a
          // failure-toned mark — and it is stated in words, not colour alone.
          return (
            <StatusPill
              tone="danger"
              label={`Over by ${formatNumber(row.overBy)} h`}
            />
          );
        }
        if (row.absenceKind) {
          return <StatusPill tone="warning" label={ABSENCE_KIND_LABEL[row.absenceKind as keyof typeof ABSENCE_KIND_LABEL] ?? row.absenceKind} />;
        }
        if (row.availableHours === 0 && row.allocatedHours === 0) {
          return <StatusPill tone="unmeasured" label="No hours recorded" />;
        }
        return <StatusPill tone="neutral" label="Within capacity" />;
      },
    },
    {
      key: 'note',
      header: 'Note',
      accessor: (row) => row.note,
      emptyLabel: 'No note',
      searchText: (row) => row.note ?? '',
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Operator workspace', href: '/ops' }]}
        title="Team capacity"
        context="Planned hours per person, leave, and the commitments that do not fit in them."
        status={
          totals && totals.remainingHours < 0 ? (
            <StatusPill
              tone="danger"
              label={`Team is over capacity by ${formatNumber(Math.abs(totals.remainingHours))} h`}
            />
          ) : undefined
        }
      />

      <p className="text-table text-muted-foreground">
        Recorded allocations for the selected period. {formatNumber(cycleIds.size)} cycle
        {cycleIds.size === 1 ? '' : 's'} referenced, {formatNumber(leaveRows.length)} leave or
        holiday allocation{leaveRows.length === 1 ? '' : 's'}.
      </p>

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => void load()}
          preserveNotice="Nothing on this page modifies capacity — a failed read changed no data."
        />
      ) : null}

      {loading && !allocations ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : (
        <>
          {totals ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <MetricTile
                label="Available hours"
                value={totals.availableHours}
                unit="h"
                note={`Summed by the server across the ${formatNumber(allocations?.length ?? 0)} allocations loaded.`}
              />
              <MetricTile
                label="Allocated hours"
                value={totals.allocatedHours}
                unit="h"
                note="Hours already committed to work items in the ledger."
              />
              <MetricTile
                label="Remaining hours"
                // A negative remainder is a real, measured shortfall, not a
                // missing value — so it stays a number and keeps its sign.
                value={totals.remainingHours}
                unit="h"
                direction="higher-is-better"
                note={
                  totals.remainingHours < 0
                    ? 'Negative: commitments exceed the hours recorded for this period.'
                    : 'Available minus allocated, as summed by the server.'
                }
              />
            </div>
          ) : null}

          {overloaded.length > 0 ? (
            <Alert variant="destructive">
              <AlertTitle>
                {overloaded.length} {overloaded.length === 1 ? 'person is' : 'people are'} over
                capacity
              </AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  These commitments cannot all be met in the recorded hours. §7.5 asks for this to be
                  visible before it is promised, and a handoff to an overloaded specialist is the
                  case it is meant to catch.
                </p>
                <ul className="list-inside list-disc space-y-1">
                  {overloaded.map((row) => (
                    <li key={row.userId}>
                      {row.personName ?? row.userId} — over by {formatNumber(row.overBy)} h (
                      {formatNumber(row.personAllocated)} h allocated against{' '}
                      {formatNumber(row.personAvailable)} h available)
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {membersError ? (
            // A 403 is not an empty team. §3.5: explain the restricted action
            // and the permitted path, and never refresh on a loop.
            <Card>
              <CardContent className="pt-6">
                <EmptyState
                  variant="insufficient-role"
                  restrictedAction="read the operator directory"
                  permittedPath="the capacity ledger below is still readable, and each allocation names its operator id"
                  layout="panel"
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Period</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="from">From</Label>
                <Input
                  id="from"
                  type="date"
                  value={filters.from}
                  onChange={(event) => setFilters({ from: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="to">To</Label>
                <Input
                  id="to"
                  type="date"
                  value={filters.to}
                  onChange={(event) => setFilters({ to: event.target.value })}
                />
              </div>
              {filters.from || filters.to ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setFilters({ from: '', to: '' })}
                >
                  Clear period
                </Button>
              ) : (
                <p className="text-meta text-muted-foreground">
                  No period selected — the server returns every recorded allocation.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Local filters over loaded rows — stated, not implied (§10.5). */}
          <FilterBar
            defaults={FILTER_DEFAULTS}
            value={filters}
            onChange={setFilters}
            controls={[
              {
                kind: 'select',
                key: 'role',
                label: 'Role',
                allLabel: 'All roles',
                options: Object.entries(OPERATOR_ROLE_LABEL).map(([value, label]) => ({
                  value,
                  label,
                })),
              },
              {
                kind: 'select',
                key: 'scope',
                label: 'Allocation scope',
                allLabel: 'All allocations',
                options: [
                  { value: 'project', label: 'Project work' },
                  { value: 'org', label: 'Not project-specific' },
                ],
              },
              {
                kind: 'select',
                key: 'absence',
                label: 'Leave',
                allLabel: 'Any',
                options: [
                  { value: 'none', label: 'No leave recorded' },
                  { value: 'leave', label: 'Leave' },
                  { value: 'holiday', label: 'Holiday' },
                  { value: 'reduced', label: 'Reduced hours' },
                ],
              },
            ]}
            searchPlaceholder="Search person, project, cycle or note…"
            summary={
              isFiltered ? (
                <>
                  Showing {formatNumber(filteredRows.length)} of {formatNumber(rows.length)} loaded
                  allocations. Filters apply to the rows loaded on this page.
                </>
              ) : (
                <>
                  {formatNumber(rows.length)} allocation{rows.length === 1 ? '' : 's'} loaded,
                  unfiltered.
                </>
              )
            }
          />

          <DataTable<AllocationRow>
            columns={columns}
            rows={filteredRows}
            getRowId={(row) => row.id}
            caption="Capacity allocations by person"
            minTableWidth="72rem"
            isLoading={loading}
            onRetry={() => void load()}
            emptyState={
              rows.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="planned capacity for this team"
                  prerequisite="capacity allocations recorded against a person"
                  layout="inline"
                >
                  <p>
                    The capacity ledger returned no allocations. That is not the same as zero
                    capacity: nobody has recorded planned hours yet, so there is nothing to compare
                    a commitment against.
                  </p>
                </EmptyState>
              ) : (
                // Rows exist; the filters excluded them. Different sentence,
                // and the only one that should offer to clear them.
                <EmptyState
                  variant="no-results"
                  onClearFilters={() =>
                    setFilters({ q: '', role: FILTER_ALL, scope: FILTER_ALL, absence: FILTER_ALL })
                  }
                  layout="inline"
                />
              )
            }
          />

          <p className="text-meta text-muted-foreground">
            &ldquo;Person total&rdquo; is the sum of the allocations listed for that person in this
            read. The endpoint does not paginate, so the listed rows are the complete matching set —
            but if a period filter is applied, the totals describe that period only.
          </p>
        </>
      )}
    </div>
  );
}
