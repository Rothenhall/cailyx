'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { ArrowRight, Download, Info, Plus } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { listProjectOptions, type ProjectOption } from '@/services/admin';
import {
  LEAD_SOURCES,
  LEAD_STATUSES,
  listPortfolioLeads,
  type LeadStatus,
  type PortfolioLead,
} from '@/services/sales';

/**
 * SL02 — Sales pipeline.
 *
 * design_plan.md §4.2: *"Leads grouped new/reached/booked/won/lost; filters,
 * export, next handoff."* The portfolio family adds *"summary strip, filter
 * bar, sortable table; selected row opens routed detail; retain
 * search/filter/scroll on return"*.
 *
 * ## Grouped, not merged
 *
 * The five pipeline stages are five sections, not one list with a status
 * column. That is §4.2's wording, and it matches the underlying fact: a lead
 * that has *reached* somebody is not in the same state as one nobody has
 * contacted, and a `won` lead is not a lead any more so much as a record of
 * what happened. Each section carries its own server-side total, so a group
 * showing nothing is a group that is empty rather than a filter that hid it.
 *
 * ## What "next handoff" means here
 *
 * Each row states the next step for its own stage and links to the lead detail
 * where that step is recorded — the handoff is a change of status plus the CTA
 * events that justify it, both of which live on SL03. The screen does not move
 * a lead itself: a status change is a claim about a conversation, and it should
 * be made where the conversation's history is visible.
 *
 * ## Export
 *
 * There is **no portfolio-level CSV route**; the backend exports per project
 * (`GET /projects/:projectId/delivery/leads/export`). The export action here
 * builds a CSV from the rows currently loaded, and says so, because a file that
 * silently omits rows is worse than no file.
 */

const FILTER_DEFAULTS = {
  q: '',
  source: FILTER_ALL,
  projectId: FILTER_ALL,
};

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  reached: 'Reached',
  booked: 'Booked',
  won: 'Won',
  lost: 'Lost',
};

const STATUS_TONE: Record<LeadStatus, StatusTone> = {
  new: 'info',
  reached: 'info',
  booked: 'warning',
  won: 'success',
  lost: 'neutral',
};

/**
 * The next step for a stage, in the operator's words.
 *
 * `won` is terminal for this pipeline: the handoff to delivery happens by
 * associating the project with a client, which is a different screen's action
 * and is not represented here as "the next click".
 */
const NEXT_STEP: Record<LeadStatus, string> = {
  new: 'Make first contact and record it',
  reached: 'Book the call',
  booked: 'Record the outcome',
  won: 'Hand over to delivery',
  lost: 'Left as lost — reopen only with new evidence',
};

/** Text tones for a count. Colour is never the only signal. */
const TONE_TEXT: Record<StatusTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  unmeasured: 'text-unmeasured',
  neutral: 'text-foreground',
};

const PAGE_SIZE = 100;

interface GroupState {
  leads: PortfolioLead[];
  total: number;
  loading: boolean;
  error: ReturnType<typeof toApiError> | null;
}

export default function SalesPipelinePage() {
  // `useSearchParams` (through `useUrlState`) forces a client-side bailout
  // during prerendering, so the URL-reading part sits behind its own boundary.
  return (
    <Suspense fallback={<PipelineSkeleton />}>
      <PipelineScreen />
    </Suspense>
  );
}

function PipelineSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

function PipelineScreen() {
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [groups, setGroups] = useState<Record<string, GroupState>>({});
  const [fatal, setFatal] = useState<ReturnType<typeof toApiError> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        setProjects(await listProjectOptions(undefined, { signal: controller.signal }));
      } catch {
        // The project filter is a convenience; losing it must not blank the
        // pipeline. The filter simply offers no project options.
        setProjects([]);
      }
    })();
    return () => controller.abort();
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setFatal(null);
      setGroups(
        Object.fromEntries(
          LEAD_STATUSES.map((status) => [
            status,
            { leads: [], total: 0, loading: true, error: null },
          ]),
        ),
      );

      const query = {
        search: filters.q.trim() === '' ? undefined : filters.q.trim(),
        source: filters.source === FILTER_ALL ? undefined : filters.source,
        projectId: filters.projectId === FILTER_ALL ? undefined : filters.projectId,
      };

      const results = await Promise.all(
        LEAD_STATUSES.map(async (status) => {
          try {
            const page = await listPortfolioLeads(
              { ...query, status, page: 1, pageSize: PAGE_SIZE },
              { signal },
            );
            return { status, page, error: null };
          } catch (caught) {
            if (caught instanceof DOMException && caught.name === 'AbortError') {
              return null;
            }
            return { status, page: null, error: toApiError(caught) };
          }
        }),
      );

      const next: Record<string, GroupState> = {};
      let firstError: ReturnType<typeof toApiError> | null = null;
      for (const result of results) {
        if (result === null) return; // aborted
        next[result.status] = {
          leads: result.page?.items ?? [],
          total: result.page?.total ?? 0,
          loading: false,
          error: result.error,
        };
        if (result.error && !firstError) firstError = result.error;
      }
      setGroups(next);
      // A 403 on every group is an access problem, not five empty lists.
      if (firstError && firstError.kind === 'forbidden') setFatal(firstError);
    },
    [filters.q, filters.source, filters.projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const all = useMemo(
    () => LEAD_STATUSES.flatMap((status) => groups[status]?.leads ?? []),
    [groups],
  );

  const totalAcrossGroups = useMemo(
    () => LEAD_STATUSES.reduce((sum, status) => sum + (groups[status]?.total ?? 0), 0),
    [groups],
  );

  const isLoading = LEAD_STATUSES.some((status) => groups[status]?.loading);

  function onExport() {
    const header = ['email', 'name', 'source', 'status', 'project', 'client', 'createdAt'];
    const rows = all.map((lead) =>
      [
        lead.email,
        lead.name ?? '',
        lead.source,
        lead.status,
        lead.projectName,
        lead.clientName ?? '',
        lead.createdAt,
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cailyx-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (fatal) {
    if (fatal.kind === 'forbidden') {
      return (
        <div className="space-y-6">
          <PageHeader title="Sales pipeline" />
          <EmptyState
            variant="insufficient-role"
            restrictedAction="read the sales pipeline"
            permittedPath="Sales, delivery leads and administrators can read it. Ask one of them, or an administrator for access."
          />
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <PageHeader title="Sales pipeline" />
        <ErrorState error={fatal} onRetry={() => void load()} />
      </div>
    );
  }

  if (isLoading && all.length === 0 && totalAcrossGroups === 0) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales pipeline"
        context={`${totalAcrossGroups} lead${totalAcrossGroups === 1 ? '' : 's'} across the projects you can see.`}
        primaryAction={{
          label: 'Intake a lead',
          href: '/ops/sales/intake',
          icon: <Plus aria-hidden="true" className="mr-2 h-4 w-4" />,
        }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={onExport} disabled={all.length === 0}>
            <Download aria-hidden="true" className="mr-2 h-4 w-4" />
            Export loaded rows
          </Button>
        }
      />

      {/*
        The two scope facts, stated: this surface is scoped by assignment, and
        the export is not a portfolio-wide one.
      */}
      <Alert>
        <Info aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>What this list includes, and what the export covers</AlertTitle>
        <AlertDescription>
          <p>
            Leads are attributed to a project, so this list is scoped through
            your assigned projects — a lead on a project outside your portfolio
            is not counted, and the totals here are totals of what you may see.
          </p>
          <p className="mt-1">
            Export builds a CSV from the rows currently loaded, up to{' '}
            {PAGE_SIZE} per stage. There is no portfolio-wide CSV route in this
            build; the backend exports one project at a time.
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {LEAD_STATUSES.map((status) => (
          <Card key={status}>
            <CardContent className="space-y-1 pt-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-meta text-muted-foreground">
                  {STATUS_LABEL[status]}
                </span>
                {/*
                  A count, not a measured value: there is no unit, window or
                  evidence behind it, so it is not a `MetricTile`. The number is
                  toned by stage and always accompanied by the stage's next step
                  in words.
                */}
                <span
                  className={`text-subsection tabular-nums font-semibold ${TONE_TEXT[STATUS_TONE[status]]}`}
                >
                  {groups[status]?.total ?? 0}
                </span>
              </div>
              <p className="text-meta text-muted-foreground">{NEXT_STEP[status]}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        controls={[
          {
            kind: 'select',
            key: 'source',
            label: 'Source',
            options: LEAD_SOURCES.map((source) => ({ value: source, label: source })),
            allLabel: 'All sources',
          },
          {
            kind: 'select',
            key: 'projectId',
            label: 'Project',
            options: projects.map((project) => ({
              value: project.id,
              label: `${project.name} · ${project.domain}`,
            })),
            allLabel: 'All projects',
          },
        ]}
        searchPlaceholder="Search by email…"
        summary={`Showing ${all.length} of ${totalAcrossGroups}`}
      />

      {all.length === 0 && !isLoading ? (
        filters.q !== '' ||
        filters.source !== FILTER_ALL ||
        filters.projectId !== FILTER_ALL ? (
          <EmptyState variant="no-results" onClearFilters={() => setFilters(FILTER_DEFAULTS)} />
        ) : (
          <EmptyState
            variant="not-measured"
            subject="sales leads"
            prerequisite="An intake run, a scorecard share, or a form submission."
          >
            No lead has been captured on any project you can see. There is no
            demo data here — an empty pipeline is empty.
          </EmptyState>
        )
      ) : (
        <div className="space-y-8">
          {LEAD_STATUSES.map((status) => (
            <StatusGroup
              key={status}
              status={status}
              group={groups[status]}
              projectFilter={filters.projectId !== FILTER_ALL ? filters.projectId : null}
              onRetry={() => void load()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusGroup({
  status,
  group,
  projectFilter,
  onRetry,
}: {
  status: LeadStatus;
  group: GroupState | undefined;
  projectFilter: string | null;
  onRetry: () => void;
}) {
  const columns = useMemo<ReadonlyArray<ColumnDef<PortfolioLead>>>(
    () => [
      {
        key: 'lead',
        header: 'Lead',
        accessor: (row) => row.email,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">
              {row.name ?? <span className="text-muted-foreground">No name recorded</span>}
            </div>
            <div className="truncate text-meta text-muted-foreground">{row.email}</div>
          </div>
        ),
        searchText: (row) => `${row.email} ${row.name ?? ''}`,
      },
      {
        key: 'source',
        header: 'Source',
        accessor: (row) => row.source,
        sortable: true,
        width: 130,
        render: (row) => <Badge variant="outline">{row.source}</Badge>,
      },
      {
        key: 'project',
        header: 'Project',
        accessor: (row) => row.projectName,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate">{row.projectName}</div>
            <div className="truncate text-meta text-muted-foreground">
              {row.clientName ?? 'No client attached'}
            </div>
          </div>
        ),
      },
      {
        key: 'createdAt',
        header: 'Captured',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 200,
        render: (row) => <Timestamp value={row.createdAt} />,
      },
      {
        key: 'nextStep',
        header: 'Next step',
        accessor: () => NEXT_STEP[status],
        width: 220,
        render: (row) => (
          <a
            className="inline-flex items-center gap-1 text-table text-primary underline-offset-4 hover:underline"
            href={`/ops/projects/${row.projectId}/sales/${row.id}`}
          >
            {NEXT_STEP[status]}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        ),
      },
    ],
    [status],
  );

  if (!group) return null;

  const truncated = group.total > group.leads.length;

  return (
    <section className="space-y-3" aria-labelledby={`group-${status}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`group-${status}`} className="text-subsection font-semibold">
          {STATUS_LABEL[status]}
        </h2>
        <StatusPill label={String(group.total)} tone={STATUS_TONE[status]} />
        {truncated ? (
          <span className="text-meta text-muted-foreground">
            Showing the {group.leads.length} most recent of {group.total} — narrow
            the filters to reach the rest.
          </span>
        ) : null}
        <span className="ml-auto text-meta text-muted-foreground">{NEXT_STEP[status]}</span>
      </div>

      <DataTable
        caption={`${STATUS_LABEL[status]} leads`}
        ariaLabel={`${STATUS_LABEL[status]} leads`}
        columns={columns}
        rows={group.leads}
        getRowId={(row) => row.id}
        defaultSort={{ key: 'createdAt', direction: 'desc' }}
        rowHref={(row) => `/ops/projects/${row.projectId}/sales/${row.id}`}
        linkColumnKey="lead"
        error={group.error}
        onRetry={onRetry}
        emptyState={
          <EmptyState
            variant="not-measured"
            subject={`leads in ${STATUS_LABEL[status].toLowerCase()}`}
            prerequisite={
              projectFilter
                ? 'A lead on this project reaching this stage.'
                : 'A lead reaching this stage. Each row here moves through the stages on its own detail screen.'
            }
          />
        }
      />
    </section>
  );
}
