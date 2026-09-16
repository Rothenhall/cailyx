'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw, Sparkles } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
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
import { formatCurrency } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  JOURNEY_SURFACES,
  deleteJourney,
  executeJourney,
  getResearchScope,
  getSuggestionWheel,
  listJourneys,
  listPersonas,
  planJourney,
  type Journey,
  type JourneySurface,
  type Persona,
  type ResearchScope,
  type SuggestionWheel,
} from '@/services/research-library';

/**
 * JO01 — Buyer journeys.
 *
 * design_plan.md §4.3: *"Suggestions, planned trees, runs by persona/status;
 * plan/execute"* — and its support note: ***"suggestions are hypotheses"***.
 *
 * That note is the rule the suggestions panel enforces. The wheel is built
 * deterministically from planner templates and the project's personas, plus
 * queries real journeys have produced. It is a set of **inferred** buyer
 * questions, not evidence that anybody asks them — each one carries its
 * awareness stage, the frustration it maps to, and where it came from, and the
 * panel says plainly that a query here is a starting point to plan from.
 *
 * The two spend boundaries are kept apart, because they are different acts:
 *
 *  - **Planning** builds a tree and executes nothing. It costs nothing and is
 *    the default action on this screen.
 *  - **Executing** walks the pending steps against an AI surface. That is the
 *    spend-incurring act, it stops at a USD cap, and it is confirmed with the
 *    cap stated rather than as a one-click row button.
 */
const FILTER_DEFAULTS = { q: '', status: 'all', persona: 'all', surface: 'all' };

export default function BuyerJourneysPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [journeys, setJourneys] = useState<Journey[] | null>(null);
  const [wheel, setWheel] = useState<SuggestionWheel | null>(null);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [planOpen, setPlanOpen] = useState(false);
  const [pendingExecute, setPendingExecute] = useState<Journey | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Journey | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [journeyList, wheelResult, personaList] = await Promise.all([
          listJourneys(projectId, undefined, { signal }),
          getSuggestionWheel(projectId, { signal }),
          listPersonas(projectId, undefined, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setJourneys(journeyList);
        setWheel(wheelResult);
        setPersonas(personaList);
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

  const personaById = useMemo(
    () => new Map((personas ?? []).map((persona) => [persona.id, persona])),
    [personas],
  );

  const filtered = useMemo(() => {
    if (!journeys) return [];
    const query = filters.q.trim().toLowerCase();
    return journeys.filter((journey) => {
      if (filters.status !== 'all' && journey.status !== filters.status) return false;
      if (filters.persona !== 'all' && journey.personaId !== filters.persona) return false;
      if (filters.surface !== 'all' && journey.surface !== filters.surface) return false;
      if (!query) return true;
      const persona = personaById.get(journey.personaId);
      return [journey.label, journey.objective, persona?.label ?? '', journey.surface]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [journeys, filters, personaById]);

  const isFiltered =
    filters.q !== '' ||
    filters.status !== 'all' ||
    filters.persona !== 'all' ||
    filters.surface !== 'all';

  async function handleExecute(journey: Journey) {
    setBusy(journey.id);
    setActionError(null);
    try {
      await executeJourney(projectId, journey.id);
      setPendingExecute(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(journey: Journey) {
    setActionError(null);
    try {
      await deleteJourney(projectId, journey.id);
      setPendingDelete(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Buyer journeys" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!journeys || !wheel || !personas) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const columns: ReadonlyArray<ColumnDef<Journey>> = [
    {
      key: 'label',
      header: 'Journey',
      accessor: (row) => row.label,
      sortable: true,
      width: 240,
      cellClassName: 'whitespace-normal',
      render: (row) => <span className="font-medium">{row.label}</span>,
    },
    {
      key: 'persona',
      header: 'Persona',
      accessor: (row) => personaById.get(row.personaId)?.label ?? 'Unknown persona',
      sortable: true,
      width: 240,
      cellClassName: 'whitespace-normal',
      render: (row) => {
        const persona = personaById.get(row.personaId);
        if (!persona) {
          return (
            <span className="text-meta text-unmeasured-foreground">
              Persona not in this project&rsquo;s list
            </span>
          );
        }
        return (
          <span className="text-meta">
            {persona.label}
            <span className="block text-muted-foreground">
              {persona.role} · {persona.awareness}
            </span>
          </span>
        );
      },
    },
    {
      key: 'surface',
      header: 'Surface',
      accessor: (row) => row.surface,
      sortable: true,
      width: 140,
      render: (row) => (
        <span className="text-meta">
          {row.surface === 'mock' ? 'Mock (no live calls)' : row.surface}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 140,
      render: (row) => <StatusPill label={journeyStatusLabel(row.status)} tone={journeyStatusTone(row.status)} />,
    },
    {
      key: 'steps',
      header: 'Steps',
      accessor: (row) => row.stepCount,
      sortable: true,
      align: 'right',
      width: 190,
      render: (row) => (
        <span className="text-meta tabular-nums">
          {row.executedSteps} of {row.stepCount} run
        </span>
      ),
    },
    {
      key: 'mentioned',
      header: 'Steps naming the client',
      accessor: (row) => row.mentionedSteps,
      sortable: true,
      align: 'right',
      width: 200,
      render: (row) => <span className="tabular-nums">{row.mentionedSteps}</span>,
    },
    {
      key: 'cost',
      header: 'Spend so far',
      accessor: (row) => row.costUsd,
      sortable: true,
      align: 'right',
      width: 150,
      render: (row) => (
        <span className="tabular-nums">{formatCurrency(row.costUsd, 'USD')}</span>
      ),
    },
    {
      key: 'plannedAt',
      header: 'Planned',
      accessor: (row) => row.plannedAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.plannedAt} />,
    },
    {
      key: 'actions',
      header: '',
      width: 220,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <a
            href={`/projects/${projectId}/research/journeys/${row.id}`}
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Open
          </a>
          {row.status === 'completed' ? (
            <span className="text-meta text-muted-foreground">Completed</span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingExecute(row)}
              disabled={busy === row.id}
            >
              {busy === row.id ? 'Running…' : 'Execute'}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setPendingDelete(row)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          projectName: scope?.projectName,
          mode: 'live',
        }}
      />
      {scopeReadFailed ? (
        <p className="text-meta text-muted-foreground">
          The project context could not be read, so the client and domain are not shown above.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Buyer journeys' },
        ]}
        title="Buyer journeys"
        context={
          <>
            {journeys.length} journey{journeys.length === 1 ? '' : 's'} planned or run ·{' '}
            {personas.filter((persona) => persona.status === 'active').length} active persona
            {personas.filter((persona) => persona.status === 'active').length === 1 ? '' : 's'}{' '}
            available to plan against
          </>
        }
        primaryAction={{ label: 'Plan a journey', onClick: () => setPlanOpen(true) }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={`/projects/${projectId}/research/campaigns`}>Campaigns</a>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">
            <Sparkles aria-hidden="true" className="mr-2 inline h-4 w-4" />
            Suggested buyer questions — hypotheses, not evidence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <ProvenanceBadge kind="derived" label="Deterministic planner templates" />
            <span className="text-meta text-muted-foreground">
              Built <Timestamp value={wheel.generatedAt} /> · {wheel.total} suggestion
              {wheel.total === 1 ? '' : 's'} · no language model was called and nothing was spent
            </span>
          </div>
          <p className="text-table text-muted-foreground">
            These are queries a buyer of this kind of service <em>might</em> run, derived from
            planner templates, this project&rsquo;s personas and queries real journeys have already
            produced. They are <strong>hypotheses about buyer behaviour</strong>, not observations of
            it — nobody has asked these questions in an answer engine yet. Planning a journey from one
            is what turns it into something measurable.
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            {wheel.stages.map((stage) => (
              <div key={stage.key} className="rounded-lg border border-border p-3">
                <h3 className="text-table font-medium">{stage.label}</h3>
                {stage.themes.length === 0 ? (
                  <p className="mt-1 text-meta text-muted-foreground">
                    No theme in the planner templates matched this awareness stage for this project.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {stage.themes.map((theme) => (
                      <li key={theme.label}>
                        <p className="text-meta font-medium text-foreground">{theme.label}</p>
                        <ul className="mt-1 space-y-1">
                          {theme.queries.map((query) => (
                            <li key={query.text} className="text-meta text-muted-foreground">
                              <span className="text-foreground">{query.text}</span>
                              <span className="block">
                                from {query.source} · maps to &ldquo;{query.painPoint}&rdquo;
                              </span>
                              <span className="block">{query.suggestion}</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          {wheel.boosts.length > 0 ? (
            <div>
              <h3 className="text-table font-medium">
                Site-specific things that would help ({wheel.boostCount})
              </h3>
              <ul className="mt-2 space-y-2">
                {wheel.boosts.map((boost) => (
                  <li key={boost.id} className="rounded-lg border border-border p-3 text-table">
                    <p className="font-medium">
                      {boost.title}{' '}
                      <span className="text-meta font-normal text-muted-foreground">
                        {boost.lane} · {boost.effort}
                      </span>
                    </p>
                    <p className="mt-1 text-meta text-muted-foreground">{boost.why}</p>
                    <p className="text-meta">{boost.action}</p>
                    <p className="text-meta text-muted-foreground">
                      Evidence: {boost.evidence}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Planned and run journeys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <FilterBar
            defaults={FILTER_DEFAULTS}
            value={filters}
            onChange={setFilters}
            controls={[
              {
                kind: 'select',
                key: 'status',
                label: 'Status',
                allLabel: 'All statuses',
                options: [
                  { value: 'planned', label: 'Planned' },
                  { value: 'running', label: 'Running' },
                  { value: 'completed', label: 'Completed' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'failed', label: 'Failed' },
                ],
              },
              {
                kind: 'select',
                key: 'persona',
                label: 'Persona',
                allLabel: 'All personas',
                options: personas.map((persona) => ({
                  value: persona.id,
                  label: `${persona.label}${persona.status === 'active' ? '' : ` (${persona.status})`}`,
                })),
              },
              {
                kind: 'select',
                key: 'surface',
                label: 'Surface',
                allLabel: 'All surfaces',
                options: [
                  { value: 'mock', label: 'Mock (no live calls)' },
                  { value: 'claude', label: 'Claude' },
                  { value: 'perplexity', label: 'Perplexity' },
                ],
              },
            ]}
            summary={`Showing ${filtered.length} of ${journeys.length}`}
          />

          <DataTable
            caption="Journeys"
            columns={columns}
            rows={filtered}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'plannedAt', direction: 'desc' }}
            minTableWidth="92rem"
            rowDetail={(row) => (
              <div className="space-y-1 text-table">
                <p className="text-muted-foreground">{row.objective}</p>
                <p className="text-meta text-muted-foreground">
                  Planned by {row.planSource}
                  {row.planModel ? ` (${row.planModel})` : ''} · depth {row.maxDepth} · branches{' '}
                  {row.maxBranches} · geography {row.geo}
                </p>
                {row.executedSteps > 0 && row.stepCount > row.executedSteps ? (
                  <p className="text-meta text-warning-foreground">
                    {row.stepCount - row.executedSteps} step
                    {row.stepCount - row.executedSteps === 1 ? '' : 's'} remain unrun — a partial
                    journey stopped at its cost cap or hit an error, and its results cover only what
                    actually ran.
                  </p>
                ) : null}
                {row.note ? (
                  <p className="text-meta">
                    <span className="text-muted-foreground">Stop note:</span>{' '}
                    <span className="evidence">{row.note}</span>
                  </p>
                ) : null}
                {row.error ? (
                  <p className="text-meta">
                    <span className="text-muted-foreground">Error:</span>{' '}
                    <span className="evidence">{row.error}</span>
                  </p>
                ) : null}
              </div>
            )}
            emptyState={
              isFiltered ? (
                <EmptyState
                  variant="no-results"
                  onClearFilters={() => setFilters({ ...FILTER_DEFAULTS })}
                />
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="Journey runs"
                  prerequisite="No journey has been planned for this project. Planning builds a tree and executes nothing; running it is a separate, cost-capped action."
                  action={{ label: 'Plan a journey', onClick: () => setPlanOpen(true) }}
                />
              )
            }
          />
        </CardContent>
      </Card>

      <PlanJourneyDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        projectId={projectId}
        personas={personas}
        onPlanned={(journey) => {
          setPlanOpen(false);
          setJourneys((current) => (current ? [journey, ...current] : [journey]));
        }}
        onError={setActionError}
      />

      <ConfirmDialog
        open={pendingExecute !== null}
        onOpenChange={(open) => {
          if (!open) setPendingExecute(null);
        }}
        title="Execute journey"
        confirmLabel="Execute journey"
        targetLabel="Journey"
        target={pendingExecute ? `${pendingExecute.label} on ${pendingExecute.surface}` : ''}
        effect={
          <>
            Walks the remaining {pendingExecute ? pendingExecute.stepCount - pendingExecute.executedSteps : 0}{' '}
            pending step
            {pendingExecute && pendingExecute.stepCount - pendingExecute.executedSteps === 1
              ? ''
              : 's'}{' '}
            against the {pendingExecute?.surface ?? 'selected'} surface and scores each answer for
            the client&rsquo;s and its competitors&rsquo; presence. This{' '}
            <strong>costs money</strong> and stops at the run&rsquo;s USD cap, marking remaining
            steps skipped if the cap is reached.
          </>
        }
        scope={
          <>
            Only this journey runs. Other planned journeys are untouched, and the answers already
            stored for it are kept.
          </>
        }
        onConfirm={async () => {
          if (pendingExecute) await handleExecute(pendingExecute);
        }}
        onReload={() => void load()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete journey"
        confirmLabel="Delete journey"
        destructive
        targetLabel="Journey"
        target={pendingDelete?.label ?? ''}
        effect={
          <>
            The journey and its whole step tree — including every stored answer and citation — are
            deleted. It cannot be recovered from this screen.
          </>
        }
        scope={
          <>
            Only this journey is affected. Its campaign, other journeys and the site itself are
            unchanged.
          </>
        }
        onConfirm={async () => {
          if (pendingDelete) await handleDelete(pendingDelete);
        }}
        onReload={() => void load()}
      />
    </div>
  );
}

function PlanJourneyDialog({
  open,
  onOpenChange,
  projectId,
  personas,
  onPlanned,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  personas: Persona[];
  onPlanned: (journey: Journey) => void;
  onError: (error: ApiError) => void;
}) {
  const activePersonas = personas.filter((persona) => persona.status === 'active');
  const [personaId, setPersonaId] = useState('');
  const [surface, setSurface] = useState<JourneySurface>('mock');
  const [geo, setGeo] = useState('US');
  const [maxDepth, setMaxDepth] = useState('4');
  const [maxBranches, setMaxBranches] = useState('2');
  const [useLlm, setUseLlm] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    setPersonaId(activePersonas[0]?.id ?? '');
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    setPlanning(true);
    setFormError(null);
    try {
      const journey = await planJourney(projectId, {
        personaId,
        surface,
        geo: geo.trim() || undefined,
        maxDepth: Number(maxDepth) || undefined,
        maxBranches: Number(maxBranches) || undefined,
        useLlm,
      });
      onPlanned(journey);
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setPlanning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (planning) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Plan a journey</DialogTitle>
          <DialogDescription>
            Builds a branching tree of searches one persona would realistically run. Planning
            executes nothing and costs nothing — running the tree is a separate action on the
            journeys list.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="No journey was created." />
        ) : null}

        {activePersonas.length === 0 ? (
          <EmptyState
            variant="not-measured"
            subject="Planning against a persona"
            prerequisite="A journey is planned for one persona and this project has no active persona. Generate or activate a persona first."
            layout="inline"
          />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="jo-persona">Persona (required)</Label>
              <Select value={personaId} onValueChange={setPersonaId}>
                <SelectTrigger id="jo-persona">
                  <SelectValue placeholder="Choose a persona" />
                </SelectTrigger>
                <SelectContent>
                  {activePersonas.map((persona) => (
                    <SelectItem key={persona.id} value={persona.id}>
                      {persona.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                Only active personas can be planned against. Draft and archived personas are not
                listed.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="jo-surface">Surface</Label>
              <Select value={surface} onValueChange={(value) => setSurface(value as JourneySurface)}>
                <SelectTrigger id="jo-surface">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JOURNEY_SURFACES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === 'mock' ? 'Mock — deterministic, no live calls' : value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                The mock surface answers deterministically and never touches a live provider, so it
                costs nothing to execute. A live surface needs the server to permit it and the
                surface&rsquo;s own key.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="jo-geo">Geography</Label>
                <Input
                  id="jo-geo"
                  value={geo}
                  onChange={(event) => setGeo(event.target.value)}
                  placeholder="US"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jo-depth">Max depth</Label>
                <Input
                  id="jo-depth"
                  type="number"
                  min={1}
                  max={6}
                  value={maxDepth}
                  onChange={(event) => setMaxDepth(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jo-branches">Max branches</Label>
                <Input
                  id="jo-branches"
                  type="number"
                  min={1}
                  max={4}
                  value={maxBranches}
                  onChange={(event) => setMaxBranches(event.target.value)}
                />
              </div>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <Label htmlFor="jo-llm">Plan with a language model</Label>
                <p className="mt-1 text-meta text-muted-foreground">
                  Swaps the deterministic planner for one model-planned tree of the same shape. It
                  costs a provider call, and a tree planned by a model is still a hypothesis about
                  buyer behaviour — it is badged as such rather than presented as research.
                </p>
              </div>
              <Switch id="jo-llm" checked={useLlm} onCheckedChange={setUseLlm} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={planning}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={planning || personaId === ''}
          >
            {planning ? 'Planning…' : 'Plan journey'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function journeyStatusTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    case 'planned':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function journeyStatusLabel(status: string): string {
  switch (status) {
    case 'planned':
      return 'Planned';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'partial':
      return 'Partial';
    case 'failed':
      return 'Failed';
    default:
      return `Unrecognized: ${status}`;
  }
}
