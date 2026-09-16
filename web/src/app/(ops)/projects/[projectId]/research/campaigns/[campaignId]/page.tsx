'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatCurrency, formatNumber } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  executeJourneyCampaign,
  getJourneyCampaign,
  getResearchScope,
  listPersonas,
  parseJsonColumn,
  type Journey,
  type JourneyCampaign,
  type Persona,
  type ResearchScope,
} from '@/services/research-library';

/**
 * JO03 — Journey campaign detail.
 *
 * design_plan.md §4.3: *"Create/list campaign, active-persona selection,
 * aggregate budget, child journeys, execute remainder"*.
 *
 * **The budget is the screen.** A campaign exists to bound a fan-out, so the
 * budget is shown as money spent against money allowed, with what remains in
 * currency — never as a percentage of an unnamed unit, and never mixed with the
 * Cloro credits an AEO measurement uses (§5.6 step 7: "Show budget **units from
 * the API**: Cloro credits are not automatically US dollars").
 *
 * Child journeys are listed rather than aggregated into "12 of 20 complete",
 * because which ones stopped is the actionable fact: a journey halted by the
 * budget is not the same as one whose surface call failed, and the run-remainder
 * action only helps with the first.
 */
export default function CampaignDetailPage() {
  const params = useParams<{ projectId: string; campaignId: string }>();
  const { projectId, campaignId } = params;

  const [campaign, setCampaign] = useState<JourneyCampaign | null>(null);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [executeOpen, setExecuteOpen] = useState(false);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [campaignResult, personaList] = await Promise.all([
          getJourneyCampaign(projectId, campaignId, { signal }),
          listPersonas(projectId, undefined, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setCampaign(campaignResult);
        setPersonas(personaList);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, campaignId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleExecute() {
    setExecuting(true);
    setActionError(null);
    try {
      await executeJourneyCampaign(projectId, campaignId);
      setExecuteOpen(false);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setExecuting(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Campaign" />
        <ErrorState error={error} notFoundReason="missing-or-private" onRetry={() => void load()} />
      </div>
    );
  }

  if (!campaign || !personas) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const journeys = campaign.journeys ?? [];
  const roles = parseJsonColumn<string[]>(campaign.personaRoles, 'array');
  const remaining = Math.max(campaign.budgetUsd - campaign.spentUsd, 0);
  const notCompleted = journeys.filter(
    (journey) => journey.status !== 'completed' && journey.status !== 'failed',
  );

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
      width: 220,
      cellClassName: 'whitespace-normal',
      render: (row) => (
        <span className="text-meta">
          {personaById.get(row.personaId)?.label ?? 'Persona not in this project’s list'}
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
      header: 'Steps run',
      accessor: (row) => row.executedSteps,
      sortable: true,
      align: 'right',
      width: 150,
      render: (row) => (
        <span className="tabular-nums">
          {row.executedSteps} of {row.stepCount}
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
      header: 'Spend',
      accessor: (row) => row.costUsd,
      sortable: true,
      align: 'right',
      width: 140,
      render: (row) => (
        <span className="tabular-nums">{formatCurrency(row.costUsd, 'USD')}</span>
      ),
    },
    {
      key: 'open',
      header: '',
      width: 100,
      alwaysVisible: true,
      render: (row) => (
        <a
          href={`/projects/${projectId}/research/journeys/${row.id}`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Open
        </a>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          market: campaign.geo,
          projectName: scope?.projectName,
          runLabel: `Campaign ${campaign.name}`,
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
          { label: 'Campaigns', href: `/projects/${projectId}/research/campaigns` },
          { label: campaign.name },
        ]}
        title={campaign.name}
        context={
          <>
            {journeys.length} child journey{journeys.length === 1 ? '' : 's'} ·{' '}
            {campaign.journeysExecuted} run · {campaign.geo} ·{' '}
            {campaign.surface === 'mock' ? 'mock surface' : campaign.surface}
          </>
        }
        status={
          <>
            <StatusPill label={campaignStatusLabel(campaign.status)} tone={campaignStatusTone(campaign.status)} />
            <ProvenanceBadge
              kind={campaign.planSource === 'llm' ? 'model-interpretation' : 'derived'}
              label={campaign.planSource === 'llm' ? 'Model-planned trees' : 'Deterministic planner'}
            />
          </>
        }
        primaryAction={{
          label: executing ? 'Running…' : 'Run remaining journeys',
          onClick: () => setExecuteOpen(true),
          disabled: executing || notCompleted.length === 0,
          disabledReason:
            notCompleted.length === 0
              ? 'Every journey in this campaign has finished. There is nothing left to run.'
              : remaining <= 0
                ? 'The budget is fully spent, so a further run would stop before doing anything.'
                : undefined,
        }}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Aggregate budget</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <dl className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <dt className="text-meta text-muted-foreground">Budget cap</dt>
              <dd className="mt-1 text-kpi tabular-nums">
                {formatCurrency(campaign.budgetUsd, 'USD')}
              </dd>
            </div>
            <div className="rounded-lg border border-border p-3">
              <dt className="text-meta text-muted-foreground">Spent so far</dt>
              <dd className="mt-1 text-kpi tabular-nums">
                {formatCurrency(campaign.spentUsd, 'USD')}
              </dd>
            </div>
            <div className="rounded-lg border border-border p-3">
              <dt className="text-meta text-muted-foreground">Remaining</dt>
              <dd className="mt-1 text-kpi tabular-nums">
                {formatCurrency(remaining, 'USD')}
              </dd>
            </div>
          </dl>
          <p className="text-meta text-muted-foreground">
            Real money spent on model calls, not credits. Execution halts the instant cumulative
            spend reaches the cap, which is why a campaign can finish &ldquo;partial&rdquo; with
            journeys that were never run — those are listed below rather than counted as failures.
          </p>
          {campaign.note ? (
            <p className="text-meta">
              <span className="text-muted-foreground">Stop note:</span>{' '}
              <span className="evidence">{campaign.note}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Fan-out configuration</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <dl className="grid gap-x-8 gap-y-3 text-table sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-meta text-muted-foreground">Active-persona selection</dt>
              <dd>
                {roles === null ? (
                  <span className="text-unmeasured-foreground">
                    The role filter stored for this campaign could not be read
                  </span>
                ) : roles.length === 0 ? (
                  'Every active persona at creation time'
                ) : (
                  roles.join(', ')
                )}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Journeys planned</dt>
              <dd className="tabular-nums">
                {campaign.journeysPlanned} of a target of {campaign.journeyTarget}
                {campaign.journeysPlanned < campaign.journeyTarget ? (
                  <span className="ml-1 text-meta text-muted-foreground">
                    (fewer personas matched than the target)
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Depth and branches</dt>
              <dd>
                depth {campaign.maxDepth} · branches {campaign.maxBranches}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Created</dt>
              <dd>
                <Timestamp value={campaign.createdAt} />
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Started</dt>
              <dd>
                {campaign.startedAt ? (
                  <Timestamp value={campaign.startedAt} />
                ) : (
                  <span className="text-muted-foreground">
                    {campaign.journeysPlanned} journey
                    {campaign.journeysPlanned === 1 ? '' : 's'} planned, nothing executed yet
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Finished</dt>
              <dd>
                {campaign.finishedAt ? (
                  <Timestamp value={campaign.finishedAt} />
                ) : (
                  <span className="text-muted-foreground">Not finished</span>
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {campaign.status === 'partial' && notCompleted.length > 0 ? (
        <Alert>
          <AlertTitle>
            Partial — {notCompleted.length} journey{notCompleted.length === 1 ? '' : 's'} did not
            complete
          </AlertTitle>
          <AlertDescription>
            Most often this is the budget cap stopping the run, which is the campaign working as
            intended rather than a fault. The journeys that did run are real evidence and stay
            readable; &ldquo;run remaining journeys&rdquo; continues from where it stopped, bounded
            by the same cap.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Child journeys</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="Journeys in this campaign"
            columns={columns}
            rows={journeys}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'plannedAt', direction: 'asc' }}
            minTableWidth="84rem"
            searchable
            rowDetail={(row) => (
              <div className="space-y-1 text-table">
                <p className="text-muted-foreground">{row.objective}</p>
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
                <p className="text-meta text-muted-foreground">
                  Planned <Timestamp value={row.plannedAt} />
                  {row.finishedAt ? (
                    <>
                      {' · finished '}
                      <Timestamp value={row.finishedAt} />
                    </>
                  ) : null}
                </p>
              </div>
            )}
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="Child journeys"
                prerequisite="This campaign has no journeys. A campaign plans one per matching active persona; none matched, or the fan-out has not run."
                layout="inline"
              />
            }
          />
        </CardContent>
      </Card>

      <p className="text-meta text-muted-foreground">
        Steps naming the client are counted per journey above. Those counts are over this
        campaign&rsquo;s own journey answers — they are not the AEO rate, which is counted over all
        collected answers on the AI-visibility screens, and the two are never combined.
        {formatNumber(campaign.journeysExecuted)} journey
        {campaign.journeysExecuted === 1 ? '' : 's'} of {formatNumber(campaign.journeysPlanned)} have
        been executed.
      </p>

      <ConfirmDialog
        open={executeOpen}
        onOpenChange={setExecuteOpen}
        title="Run remaining journeys"
        confirmLabel="Run remaining journeys"
        targetLabel="Campaign"
        target={campaign.name}
        cost={
          remaining > 0
            ? { costCurrency: remaining, currencyCode: 'USD' }
            : { costCurrency: 0, currencyCode: 'USD' }
        }
        effect={
          <>
            Runs the {notCompleted.length} not-yet-completed journey
            {notCompleted.length === 1 ? '' : 's'} in order, stopping the instant cumulative spend
            reaches the campaign budget. Journeys already completed are not re-run and are not
            charged again.
          </>
        }
        scope={
          <>
            Only this campaign&rsquo;s journeys are affected. Their stored answers and the journeys
            of other campaigns are untouched.
          </>
        }
        onConfirm={handleExecute}
        onReload={() => void load()}
      />
    </div>
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
