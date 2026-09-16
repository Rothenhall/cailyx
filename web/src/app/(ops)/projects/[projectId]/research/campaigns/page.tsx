'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatCurrency } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  JOURNEY_SURFACES,
  createJourneyCampaign,
  executeJourneyCampaign,
  getResearchScope,
  listJourneyCampaigns,
  listPersonas,
  parseJsonColumn,
  type JourneyCampaign,
  type JourneySurface,
  type Persona,
  type ResearchScope,
} from '@/services/research-library';

/**
 * JO03 — Journey campaigns (list and create).
 *
 * design_plan.md §4.3: *"Create/list campaign, active-persona selection,
 * aggregate budget, child journeys, execute remainder"*.
 *
 * A campaign is the one lever that bounds a large swarm run: it plans one
 * journey per matching **active** persona, and execution halts the instant
 * cumulative spend reaches the campaign's USD budget. Three consequences this
 * screen makes explicit rather than leaving to be discovered:
 *
 *  1. **Creating a campaign can spend.** `autoRun` defaults to true on the
 *     server, so "create" means "plan and run". The form states that, shows the
 *     budget that bounds it, and is confirmed with the resulting fan-out.
 *  2. **The budget is money, not credits.** It is a real USD cap on model calls.
 *     It is shown as currency and never mixed with the credit figures used for
 *     AEO measurement.
 *  3. **Only active personas can be fanned out over.** A campaign that matches
 *     no active persona is rejected by the server rather than silently producing
 *     an empty run, and the form says which personas each role selection picks
 *     up.
 */
export default function JourneyCampaignsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [campaigns, setCampaigns] = useState<JourneyCampaign[] | null>(null);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [campaignList, personaList] = await Promise.all([
          listJourneyCampaigns(projectId, { signal }),
          listPersonas(projectId, undefined, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setCampaigns(campaignList);
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

  const activePersonas = useMemo(
    () => (personas ?? []).filter((persona) => persona.status === 'active'),
    [personas],
  );

  async function handleExecute(campaign: JourneyCampaign) {
    setBusy(campaign.id);
    setActionError(null);
    try {
      await executeJourneyCampaign(projectId, campaign.id);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Journey campaigns" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!campaigns || !personas) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const columns: ReadonlyArray<ColumnDef<JourneyCampaign>> = [
    {
      key: 'name',
      header: 'Campaign',
      accessor: (row) => row.name,
      sortable: true,
      width: 240,
      cellClassName: 'whitespace-normal',
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 140,
      render: (row) => <StatusPill label={campaignStatusLabel(row.status)} tone={campaignStatusTone(row.status)} />,
    },
    {
      key: 'progress',
      header: 'Journeys',
      accessor: (row) => row.journeysExecuted,
      sortable: true,
      align: 'right',
      width: 200,
      render: (row) => (
        <span className="text-meta tabular-nums">
          {row.journeysExecuted} of {row.journeysPlanned} run
          {row.journeyTarget !== row.journeysPlanned ? ` (target ${row.journeyTarget})` : ''}
        </span>
      ),
    },
    {
      key: 'budget',
      header: 'Budget used',
      accessor: (row) => row.spentUsd,
      sortable: true,
      align: 'right',
      width: 230,
      render: (row) => (
        <span className="tabular-nums">
          {formatCurrency(row.spentUsd, 'USD')} of {formatCurrency(row.budgetUsd, 'USD')}
        </span>
      ),
    },
    {
      key: 'personaRoles',
      header: 'Persona roles',
      accessor: (row) => parseJsonColumn<string[]>(row.personaRoles, 'array')?.join(', ') ?? '',
      width: 230,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'Any active persona',
      render: (row) => {
        const roles = parseJsonColumn<string[]>(row.personaRoles, 'array');
        if (roles === null) {
          return (
            <span className="text-meta text-unmeasured-foreground">
              Role filter could not be read
            </span>
          );
        }
        return (
          <span className="text-meta">
            {roles.length === 0 ? 'Any active persona' : roles.join(', ')}
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
      key: 'createdAt',
      header: 'Created',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'actions',
      header: '',
      width: 200,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <a
            href={`/projects/${projectId}/research/campaigns/${row.id}`}
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
              onClick={() => void handleExecute(row)}
              disabled={busy === row.id}
            >
              {busy === row.id ? 'Running…' : 'Run remainder'}
            </Button>
          )}
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
          { label: 'Buyer journeys', href: `/projects/${projectId}/research/journeys` },
          { label: 'Campaigns' },
        ]}
        title="Journey campaigns"
        context={
          <>
            {campaigns.length} campaign{campaigns.length === 1 ? '' : 's'} ·{' '}
            {activePersonas.length} active persona
            {activePersonas.length === 1 ? '' : 's'} available to fan out over
          </>
        }
        primaryAction={{ label: 'New campaign', onClick: () => setCreateOpen(true) }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      <Alert>
        <AlertTitle>A campaign is a budgeted fan-out, not a batch job</AlertTitle>
        <AlertDescription>
          One journey is planned per matching <strong>active</strong> persona, and execution stops the
          instant cumulative spend reaches the campaign&rsquo;s USD budget. The budget is real money
          spent on model calls — it is never mixed with the credit figures used for AI-visibility
          measurement, which are a different unit from a different vendor.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Campaigns</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="Journey campaigns"
            columns={columns}
            rows={campaigns}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'createdAt', direction: 'desc' }}
            minTableWidth="88rem"
            searchable
            rowDetail={(row) => (
              <div className="space-y-1 text-table">
                <p className="text-meta text-muted-foreground">
                  Geography {row.geo} · depth {row.maxDepth} · branches {row.maxBranches} · planned by{' '}
                  {row.planSource}
                </p>
                <p className="text-meta">
                  <span className="text-muted-foreground">Budget remaining:</span>{' '}
                  <span className="tabular-nums">
                    {formatCurrency(Math.max(row.budgetUsd - row.spentUsd, 0), 'USD')}
                  </span>
                </p>
                {row.note ? (
                  <p className="text-meta">
                    <span className="text-muted-foreground">Stop note:</span>{' '}
                    <span className="evidence">{row.note}</span>
                  </p>
                ) : null}
              </div>
            )}
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="Journey campaigns"
                prerequisite="No campaign exists for this project. A campaign needs at least one active persona to fan out over."
                action={{ label: 'New campaign', onClick: () => setCreateOpen(true) }}
              />
            }
          />
        </CardContent>
      </Card>

      <CreateCampaignDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        activePersonas={activePersonas}
        totalPersonas={personas.length}
        onCreated={(campaign) => {
          setCreateOpen(false);
          setCampaigns((current) => (current ? [campaign, ...current] : [campaign]));
          window.location.assign(`/projects/${projectId}/research/campaigns/${campaign.id}`);
        }}
        onError={setActionError}
      />
    </div>
  );
}

function CreateCampaignDialog({
  open,
  onOpenChange,
  projectId,
  activePersonas,
  totalPersonas,
  onCreated,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  activePersonas: Persona[];
  totalPersonas: number;
  onCreated: (campaign: JourneyCampaign) => void;
  onError: (error: ApiError) => void;
}) {
  const [name, setName] = useState('');
  const [journeyTarget, setJourneyTarget] = useState('10');
  const [budgetUsd, setBudgetUsd] = useState('5');
  const [surface, setSurface] = useState<JourneySurface>('mock');
  const [geo, setGeo] = useState('US');
  const [maxDepth, setMaxDepth] = useState('4');
  const [maxBranches, setMaxBranches] = useState('2');
  const [roles, setRoles] = useState<string[]>([]);
  const [useLlm, setUseLlm] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  /**
   * The roles an operator can filter on are the roles this project's *active*
   * personas actually have — offering a role nobody fills would produce a
   * campaign that matches nothing.
   */
  const availableRoles = useMemo(() => {
    const present = new Set(activePersonas.map((persona) => persona.role));
    return [...present].sort();
  }, [activePersonas]);

  const matchedPersonas = useMemo(
    () =>
      roles.length === 0
        ? activePersonas
        : activePersonas.filter((persona) => roles.includes(persona.role)),
    [activePersonas, roles],
  );

  const plannedJourneys = Math.min(
    Number(journeyTarget) || 0,
    matchedPersonas.length || Number(journeyTarget) || 0,
  );

  async function submit() {
    setSaving(true);
    setFormError(null);
    try {
      const campaign = await createJourneyCampaign(projectId, {
        name: name.trim(),
        journeyTarget: Number(journeyTarget),
        budgetUsd: Number(budgetUsd),
        surface,
        geo: geo.trim() || undefined,
        maxDepth: Number(maxDepth) || undefined,
        maxBranches: Number(maxBranches) || undefined,
        personaRoles: roles.length > 0 ? roles : undefined,
        useLlm,
        autoRun,
      });
      onCreated(campaign);
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New journey campaign</DialogTitle>
          <DialogDescription>
            Plans one journey per matching active persona under a single USD budget. With
            &ldquo;plan and run&rdquo; on — the server default — creating the campaign also executes
            it, halting the moment cumulative spend reaches the budget.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            providerName="the journey surface"
            preserveNotice="No campaign was created."
          />
        ) : null}

        {activePersonas.length === 0 ? (
          <EmptyState
            variant="not-measured"
            subject="Campaign fan-out"
            prerequisite={`A campaign plans one journey per active persona, and this project has none active (${totalPersonas} exist in other states). Activate a persona first.`}
            layout="inline"
          />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="jo3-name">Campaign name (required)</Label>
              <Input
                id="jo3-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="e.g. Q4 objection research sweep"
              />
            </div>

            <fieldset className="space-y-2">
              <legend className="text-table font-medium">
                Active-persona selection
              </legend>
              <p className="text-meta text-muted-foreground">
                Choose roles to narrow the fan-out. Leave every box clear to use every active
                persona. Only roles this project&rsquo;s active personas actually have are listed.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {availableRoles.map((role) => (
                  <div key={role} className="flex items-center gap-2">
                    <Checkbox
                      id={`jo3-role-${role}`}
                      checked={roles.includes(role)}
                      onCheckedChange={(checked) =>
                        setRoles((current) =>
                          checked === true
                            ? [...current, role]
                            : current.filter((value) => value !== role),
                        )
                      }
                    />
                    <Label htmlFor={`jo3-role-${role}`} className="capitalize">
                      {role.replace(/-/g, ' ')}
                    </Label>
                  </div>
                ))}
              </div>
              <p className="text-meta">
                {roles.length === 0
                  ? `All ${activePersonas.length} active persona${activePersonas.length === 1 ? '' : 's'} match.`
                  : `${matchedPersonas.length} of ${activePersonas.length} active personas match: ${
                      matchedPersonas.map((persona) => persona.label).join(', ') ||
                      'none — the server will reject a campaign that matches no persona'
                    }`}
              </p>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="jo3-target">Journeys to plan (required)</Label>
                <Input
                  id="jo3-target"
                  type="number"
                  min={1}
                  max={200}
                  value={journeyTarget}
                  onChange={(event) => setJourneyTarget(event.target.value)}
                />
                <p className="text-meta text-muted-foreground">
                  Capped at the number of matching personas — a campaign cannot plan more journeys
                  than it has personas to fan out over.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="jo3-budget">Budget cap, USD (required)</Label>
                <Input
                  id="jo3-budget"
                  type="number"
                  min={0.01}
                  max={100}
                  step="0.01"
                  value={budgetUsd}
                  onChange={(event) => setBudgetUsd(event.target.value)}
                />
                <p className="text-meta text-muted-foreground">
                  Real money spent on model calls. Execution halts the instant cumulative spend
                  reaches it.
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3 text-table">
              <p className="font-medium">
                {plannedJourneys} journey{plannedJourneys === 1 ? '' : 's'} across{' '}
                {matchedPersonas.length || 0} persona
                {matchedPersonas.length === 1 ? '' : 's'}, capped at{' '}
                {formatCurrency(Number(budgetUsd) || 0, 'USD')}
              </p>
              <p className="mt-1 text-meta text-muted-foreground">
                Each journey is planned by {useLlm ? 'a language model' : 'the deterministic planner'}
                {useLlm ? ' (one provider call per journey, before any execution)' : ''}. The budget
                covers execution only; it is not a promise about how many journeys complete.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="jo3-geo">Geography</Label>
                <Input
                  id="jo3-geo"
                  value={geo}
                  onChange={(event) => setGeo(event.target.value)}
                  placeholder="US"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jo3-depth">Max depth</Label>
                <Input
                  id="jo3-depth"
                  type="number"
                  min={1}
                  max={6}
                  value={maxDepth}
                  onChange={(event) => setMaxDepth(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jo3-branches">Max branches</Label>
                <Input
                  id="jo3-branches"
                  type="number"
                  min={1}
                  max={4}
                  value={maxBranches}
                  onChange={(event) => setMaxBranches(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="jo3-surface">Surface</Label>
              <Select value={surface} onValueChange={(value) => setSurface(value as JourneySurface)}>
                <SelectTrigger id="jo3-surface">
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
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <Label htmlFor="jo3-llm">Plan journeys with a language model</Label>
                <p className="mt-1 text-meta text-muted-foreground">
                  Swaps the deterministic planner for model-planned trees. Costs one provider call
                  per journey, and a model-planned tree is still a hypothesis about buyer behaviour.
                </p>
              </div>
              <Switch id="jo3-llm" checked={useLlm} onCheckedChange={setUseLlm} />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <Label htmlFor="jo3-autorun">Plan and run now</Label>
                <p className="mt-1 text-meta text-muted-foreground">
                  On: creating the campaign executes its journeys immediately, spending against the
                  budget above. Off: the journeys are planned only, and you run them later from the
                  campaign screen.
                </p>
              </div>
              <Switch id="jo3-autorun" checked={autoRun} onCheckedChange={setAutoRun} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              saving ||
              activePersonas.length === 0 ||
              name.trim().length < 3 ||
              matchedPersonas.length === 0
            }
          >
            {saving ? 'Creating…' : autoRun ? 'Create and run campaign' : 'Create campaign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function campaignStatusTone(status: string): StatusTone {
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

function campaignStatusLabel(status: string): string {
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
