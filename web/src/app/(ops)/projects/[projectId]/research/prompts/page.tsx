'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Download, RefreshCw } from 'lucide-react';
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
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import type { ApiError } from '@/lib/api';
import {
  PROMPT_PERSONAS,
  PROMPT_PERSONA_LABEL,
  createQuerySet,
  exportQuerySets,
  getResearchScope,
  listQuerySets,
  querySetProvenance,
  type PromptPersona,
  type QuerySet,
  type ResearchScope,
} from '@/services/research-library';

/**
 * QS01 — Prompt library.
 *
 * design_plan.md §4.3: *"Sets by awareness label/version/status, provenance,
 * export, create"*, in the portfolio/library family: *"searchable/filterable
 * table, saved views, bulk selection, column configuration, row detail"*.
 *
 * Two things this page refuses to do:
 *
 *  1. **Show a set's provenance as a single word.** §5.6 step 4 separates a
 *     query set's `persona` — an *awareness-stage label* — from a row in the
 *     synthetic Persona module: "Do not assume those two fields are
 *     interchangeable foreign keys." The create form says so in words, because
 *     an operator who picks "Product aware" here expecting it to bind a Persona
 *     would be building the wrong thing.
 *  2. **Present a created set as live.** A new set is a `draft` and nothing
 *     measures against it until it is activated, which freezes it. The status
 *     column carries that, and the row detail repeats it.
 *
 * The awareness/version/status breakdown is shown as its own summary rather
 * than folded into one "sets" number, because "we have 6 sets" and "we have a
 * measured baseline for 2 of the 4 awareness stages" are different facts.
 */
const FILTER_DEFAULTS = { q: '', awareness: 'all', status: 'all' };

export default function PromptLibraryPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [sets, setSets] = useState<QuerySet[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const [createOpen, setCreateOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [result] = await Promise.all([
          listQuerySets(projectId, undefined, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setSets(result);
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

  const filtered = useMemo(() => {
    if (!sets) return [];
    const query = filters.q.trim().toLowerCase();
    return sets.filter((set) => {
      if (filters.awareness !== 'all' && set.persona !== filters.awareness) return false;
      if (filters.status !== 'all' && set.status !== filters.status) return false;
      if (!query) return true;
      const haystack = [
        set.label ?? '',
        set.persona,
        PROMPT_PERSONA_LABEL[set.persona] ?? set.persona,
        `v${set.version}`,
        set.source,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [sets, filters]);

  const isFiltered = filters.q !== '' || filters.awareness !== 'all' || filters.status !== 'all';

  /** Per-awareness-stage read: how many versions exist and whether one is active. */
  const byAwareness = useMemo(() => {
    if (!sets) return [];
    return PROMPT_PERSONAS.map((persona) => {
      const rows = sets.filter((set) => set.persona === persona);
      const active = rows.filter((set) => set.status === 'active');
      const latest = rows.reduce<QuerySet | null>(
        (max, row) => (max === null || row.version > max.version ? row : max),
        null,
      );
      return {
        persona,
        label: PROMPT_PERSONA_LABEL[persona] ?? persona,
        versions: rows.length,
        activeVersion: active.length ? Math.max(...active.map((row) => row.version)) : null,
        latest,
      };
    });
  }, [sets]);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const exported = await exportQuerySets(projectId);
      const blob = new Blob([JSON.stringify({ projectId, querySets: exported }, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `query-sets-${projectId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setExportError(toApiError(caught));
    } finally {
      setExporting(false);
    }
  }

  const columns: ReadonlyArray<ColumnDef<QuerySet>> = [
    {
      key: 'awareness',
      header: 'Awareness label',
      accessor: (row) => PROMPT_PERSONA_LABEL[row.persona] ?? row.persona,
      sortable: true,
      width: 170,
      render: (row) => (
        <span className="text-table">
          {PROMPT_PERSONA_LABEL[row.persona] ?? row.persona}
        </span>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      accessor: (row) => row.version,
      sortable: true,
      align: 'right',
      width: 90,
      render: (row) => <span className="tabular-nums">v{row.version}</span>,
    },
    {
      key: 'label',
      header: 'Label',
      accessor: (row) => row.label ?? '',
      sortable: true,
      // A missing label is an unset name, not a missing measurement.
      emptyLabel: 'No label',
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 120,
      render: (row) => <StatusPill label={setStatusLabel(row.status)} tone={setStatusTone(row.status)} />,
    },
    {
      key: 'items',
      header: 'Prompts',
      accessor: (row) => row.items?.length ?? null,
      sortable: true,
      align: 'right',
      width: 100,
      emptyLabel: 'Not counted',
      render: (row) =>
        row.items ? <span className="tabular-nums">{row.items.length}</span> : null,
    },
    {
      key: 'provenance',
      header: 'Provenance',
      accessor: (row) => row.source,
      width: 210,
      render: (row) => {
        const provenance = querySetProvenance(row.source);
        return <ProvenanceBadge kind={provenance.kind} label={provenance.label} />;
      },
    },
    {
      key: 'createdAt',
      header: 'Created',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'open',
      header: '',
      width: 100,
      alwaysVisible: true,
      render: (row) => (
        <a
          href={`/projects/${projectId}/research/prompts/${row.id}`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Open set
        </a>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Prompt library" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!sets) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const measuredStages = byAwareness.filter((row) => row.activeVersion !== null).length;

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{ clientName: scope?.clientName ?? undefined, domain: scope?.domain, projectName: scope?.projectName, mode: 'live' }}
      />
      {scopeReadFailed ? (
        <p className="text-meta text-muted-foreground">
          The project context could not be read, so the client and domain are not shown above.
          Everything below is still scoped to the project in the URL.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Prompt library' },
        ]}
        title="Prompt library"
        context={
          <>
            {sets.length} set{sets.length === 1 ? '' : 's'} ·{' '}
            {measuredStages} of {PROMPT_PERSONAS.length} awareness labels have an active version
          </>
        }
        primaryAction={{ label: 'New prompt set', onClick: () => setCreateOpen(true) }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleExport()}
              disabled={exporting || sets.length === 0}
              title={sets.length === 0 ? 'Nothing to export yet' : undefined}
            >
              <Download aria-hidden="true" className="mr-2 h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export JSON'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {exportError ? <ErrorState error={exportError} layout="inline" onRetry={() => void handleExport()} /> : null}
      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Coverage by awareness label</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {byAwareness.map((row) => (
              <div key={row.persona} className="rounded-lg border border-border p-3">
                <dt className="text-meta font-medium text-foreground">{row.label}</dt>
                <dd className="mt-1 text-meta text-muted-foreground">
                  {row.versions === 0
                    ? 'No set yet'
                    : `${row.versions} version${row.versions === 1 ? '' : 's'} · ${
                        row.activeVersion === null
                          ? 'nothing activated'
                          : `v${row.activeVersion} active`
                      }`}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-meta text-muted-foreground">
            These are awareness-stage labels on the prompt set itself (design_plan §5.6 step 4) —
            not rows in the synthetic Persona module. Only an <strong>active</strong> version is
            what a measurement run references; a set that has never been activated is a draft.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Sets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <FilterBar
            defaults={FILTER_DEFAULTS}
            value={filters}
            onChange={setFilters}
            controls={[
              {
                kind: 'select',
                key: 'awareness',
                label: 'Awareness label',
                allLabel: 'All labels',
                options: PROMPT_PERSONAS.map((persona) => ({
                  value: persona,
                  label: PROMPT_PERSONA_LABEL[persona] ?? persona,
                })),
              },
              {
                kind: 'select',
                key: 'status',
                label: 'Status',
                allLabel: 'All statuses',
                options: [
                  { value: 'draft', label: 'Draft' },
                  { value: 'active', label: 'Active' },
                  { value: 'archived', label: 'Archived' },
                ],
              },
            ]}
            summary={`Showing ${filtered.length} of ${sets.length}`}
          />

          <DataTable
            caption="Prompt sets"
            columns={columns}
            rows={filtered}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'createdAt', direction: 'desc' }}
            minTableWidth="64rem"
            rowDetail={(row) => <SetDetail row={row} />}
            emptyState={
              isFiltered ? (
                <EmptyState
                  variant="no-results"
                  onClearFilters={() => setFilters({ ...FILTER_DEFAULTS })}
                />
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="Prompt sets"
                  prerequisite="A prompt set starts as a draft you write; activating it freezes the version a measurement run will reference."
                  action={{ label: 'New prompt set', onClick: () => setCreateOpen(true) }}
                />
              )
            }
          />
        </CardContent>
      </Card>

      <CreateSetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        existing={sets}
        onCreated={(created) => {
          setCreateOpen(false);
          setSets((current) => (current ? [created, ...current] : [created]));
        }}
        onError={setActionError}
      />
    </div>
  );
}

/** Row detail: what each lifecycle state actually means for this set. */
function SetDetail({ row }: { row: QuerySet }) {
  const stages = new Map<string, number>();
  for (const item of row.items ?? []) {
    const stage = PROMPT_PERSONA_LABEL[item.funnelStage] ?? item.funnelStage;
    stages.set(stage, (stages.get(stage) ?? 0) + 1);
  }

  return (
    <div className="space-y-3 text-table">
      <p className="text-muted-foreground">
        {row.status === 'draft'
          ? 'Draft — prompts can still be added or removed. Nothing measures against it yet.'
          : row.status === 'active'
            ? 'Active and frozen. A measurement run references this exact version; editing it means forking a new draft.'
            : 'Archived. Kept for reference; measurement runs reference the active version.'}
      </p>
      {row.activatedAt ? (
        <p className="text-meta text-muted-foreground">
          Activated <Timestamp value={row.activatedAt} />
        </p>
      ) : null}
      {stages.size > 0 ? (
        <div>
          <h4 className="text-meta font-medium text-foreground">Funnel stages in this set</h4>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
            {[...stages.entries()].map(([stage, count]) => (
              <li key={stage}>
                {stage}: <span className="tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CreateSetDialog({
  open,
  onOpenChange,
  projectId,
  existing,
  onCreated,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  existing: QuerySet[];
  onCreated: (set: QuerySet) => void;
  onError: (error: ApiError) => void;
}) {
  const [persona, setPersona] = useState<PromptPersona>('problem-aware');
  const [label, setLabel] = useState('');
  const [firstPrompt, setFirstPrompt] = useState('');
  const [funnelStage, setFunnelStage] = useState<PromptPersona>('problem-aware');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  const takenPersonas = new Set(
    existing.filter((set) => set.version === 1).map((set) => set.persona),
  );
  const personaTaken = takenPersonas.has(persona);

  async function submit() {
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createQuerySet(projectId, {
        persona,
        label: label.trim() || undefined,
        prompt: firstPrompt.trim() || undefined,
        funnelStage: firstPrompt.trim() ? funnelStage : undefined,
      });
      setLabel('');
      setFirstPrompt('');
      onCreated(created);
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New prompt set</DialogTitle>
          <DialogDescription>
            Creates the version-1 draft for one awareness label. A second v1 for the same label is
            rejected by the server — the existing set is forked to make a new version instead.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Nothing was created." />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="qs-awareness">Awareness label</Label>
            <Select value={persona} onValueChange={(value) => setPersona(value as PromptPersona)}>
              <SelectTrigger id="qs-awareness">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROMPT_PERSONAS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {PROMPT_PERSONA_LABEL[value] ?? value}
                    {takenPersonas.has(value) ? ' — v1 already exists' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-meta text-muted-foreground">
              This is an awareness-stage label on the prompt set (design_plan §5.6 step 4), not a
              synthetic Persona row. Choosing a label here does not attach a persona.
            </p>
            {personaTaken ? (
              <p className="text-meta text-warning-foreground">
                A version-1 set already exists for this label. Creating another will be rejected —
                open the existing set and fork it for a new version.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="qs-label">Label (optional)</Label>
            <Input
              id="qs-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Q4 buyer questions"
              maxLength={200}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="qs-first-prompt">First prompt (optional)</Label>
            <Input
              id="qs-first-prompt"
              value={firstPrompt}
              onChange={(event) => setFirstPrompt(event.target.value)}
              placeholder="The buyer question this set should start with"
            />
          </div>

          {firstPrompt.trim() ? (
            <div className="space-y-2">
              <Label htmlFor="qs-funnel">Funnel stage for that prompt</Label>
              <Select
                value={funnelStage}
                onValueChange={(value) => setFunnelStage(value as PromptPersona)}
              >
                <SelectTrigger id="qs-funnel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROMPT_PERSONAS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {PROMPT_PERSONA_LABEL[value] ?? value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create draft set'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function setStatusTone(status: string): StatusTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'info';
    case 'archived':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function setStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'draft':
      return 'Draft';
    case 'archived':
      return 'Archived';
    default:
      return `Unrecognized: ${status}`;
  }
}
