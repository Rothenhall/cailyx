'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import {
  AlertTriangle,
  Ban,
  CircleDollarSign,
  Coins,
  Info,
  RefreshCw,
  ShieldQuestion,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatCredits, formatCurrency, notMeasuredLabel } from '@/lib/format';
import {
  BUDGET_ENFORCEMENTS,
  BUDGET_PERIODS,
  TASK_KINDS,
  approveReservation,
  createCostEstimate,
  getBudgetView,
  getSpendView,
  listProjectOptions,
  listReservations,
  putBudgetPolicy,
  releaseReservation,
  settleReservation,
  type BudgetView,
  type CostEstimateView,
  type ProjectOption,
  type ProviderBalance,
  type ReservationView,
  type SpendView,
  type TaskKind,
  type UnitTotal,
} from '@/services/admin';

/**
 * OP18 — Budgets.
 *
 * design_plan.md §4.2: *"Client/project/operation budget, estimates, actual
 * spend, reservations and approval queue."*
 *
 * ## Three rules this screen exists to not break
 *
 * 1. **Units never mix.** A dollar amount and a credit amount are different
 *    quantities. Every aggregate on this page carries its own unit, they are
 *    rendered in separate rows, and there is no combined total anywhere —
 *    the API never returns one, and this screen does not compute one.
 * 2. **Unknown is never "fits".** A provider balance that could not be read
 *    comes back as `{ state: 'unknown', reason }` and is rendered as unknown.
 *    `affordability: 'unknown'` is a first-class answer and is shown as one.
 * 3. **A hold is not spend.** `reservedHeld` and `settled` are separate columns
 *    per unit. Nothing here adds them together, and a held reservation is
 *    labelled as held rather than counted as money spent.
 *
 * ## The honest limit of this screen
 *
 * There is **no cross-project budget route**. Every budget read and write is
 * nested under `/projects/:projectId` and is gated by project access, so an
 * organization-wide budget total does not exist in this API. Rather than fan
 * out one request per project — which §10.3 forbids, since the global limit is
 * 100 requests/minute/IP — the screen works one project at a time and says so.
 */

/**
 * URL state. Written without `as const` so each key keeps its widened type —
 * a literal type here would make every `setState` patch that assigns a runtime
 * string a compile error.
 */
const STATE: {
  q: string;
  tab: string;
  projectId: string;
  taskKind: string;
  estimateTaskKind: string;
} = {
  q: '',
  tab: 'ceilings',
  projectId: '',
  taskKind: 'all',
  estimateTaskKind: 'aeo-audit',
};

const UNIT_LABEL: Record<string, string> = { usd: 'US dollars', credits: 'Provider credits' };

export default function AdminBudgetsPage() {
  // `useSearchParams` (through `useUrlState`) forces a client-side bailout
  // during prerendering, so the URL-reading part sits behind its own boundary.
  return (
    <Suspense fallback={<BudgetsSkeleton />}>
      <BudgetsScreen />
    </Suspense>
  );
}

function BudgetsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-32 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

function BudgetsScreen() {
  const [state, setState] = useUrlState(STATE);
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [spend, setSpend] = useState<SpendView | null>(null);
  const [reservations, setReservations] = useState<{
    awaitingApprovalCount: number;
    reservations: ReservationView[];
  } | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const projectId = state.projectId || undefined;
  const taskKind = state.taskKind === 'all' ? undefined : state.taskKind;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        setProjects(await listProjectOptions(undefined, { signal: controller.signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    })();
    return () => controller.abort();
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!projectId) {
        setBudget(null);
        setSpend(null);
        setReservations(null);
        return;
      }
      setIsLoading(true);
      try {
        setError(null);
        const [budgetResult, spendResult, reservationResult] = await Promise.all([
          getBudgetView(projectId, taskKind, { signal }),
          getSpendView(projectId, { taskKind }, { signal }),
          listReservations(projectId, { taskKind, limit: 100 }, { signal }),
        ]);
        setBudget(budgetResult);
        setSpend(spendResult);
        setReservations(reservationResult);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, taskKind],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error?.kind === 'forbidden' && !projectId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Spending limits" />
        <EmptyState
          variant="insufficient-role"
          restrictedAction="read budget ceilings and spend"
          permittedPath="A budget is read per project and requires access to that project. Ask a delivery lead or administrator to check it, or have yourself assigned to the project."
        />
      </div>
    );
  }

  if (!projects) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spending limits"
        context={
          selectedProject
            ? `${selectedProject.name} · ${selectedProject.domain}${
                taskKind ? ` · narrowed to ${taskKind}` : ' · all operation ceilings included'
              }`
            : 'Ceilings, estimates, actual spend and reservations.'
        }
        secondaryActions={
          projectId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={isLoading}
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              {isLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
          ) : undefined
        }
      />

      {/*
        The scope limit, stated rather than implied by an empty screen. An
        organization-wide budget total is not something this API can answer,
        and pretending otherwise would invite a number that does not exist.
      */}
      <Alert>
        <Info aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>Budgets are read one project at a time</AlertTitle>
        <AlertDescription>
          Every budget route is scoped to a project and gated by project access,
          and no cross-project aggregate exists in this build. There is
          therefore no organization-wide budget total on this screen — pick a
          project below. Client-scoped ceilings appear on the project that the
          client owns, because that is where they are evaluated.
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="budget-project">Project</Label>
            <Select
              value={state.projectId || undefined}
              onValueChange={(value) => setState({ projectId: value, tab: 'ceilings' }, { push: true })}
            >
              <SelectTrigger id="budget-project">
                <SelectValue placeholder="Choose a project…" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name} · {project.domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-meta text-muted-foreground">
              {projects.length} project{projects.length === 1 ? '' : 's'} visible
              to you. A project outside your assignments is not listed.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="budget-task-kind">Operation scope</Label>
            <Select
              value={state.taskKind}
              onValueChange={(value) => setState({ taskKind: value })}
            >
              <SelectTrigger id="budget-task-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All work (project and client ceilings)</SelectItem>
                {TASK_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-meta text-muted-foreground">
              Operation-level ceilings are only evaluated when one kind of work
              is named, because a ceiling written for one operation does not cap
              another.
            </p>
          </div>
        </CardContent>
      </Card>

      {!projectId ? (
        <EmptyState
          variant="not-measured"
          subject="budget data"
          prerequisite="Choosing a project above. Budgets are stored per project and cannot be read without one."
        />
      ) : error ? (
        <ErrorState
          error={error}
          onRetry={() => void load()}
          notFoundReason="prerequisite"
        />
      ) : !budget || !spend || !reservations ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <Tabs value={state.tab} onValueChange={(value) => setState({ tab: value })}>
          <TabsList>
            <TabsTrigger value="ceilings">Ceilings</TabsTrigger>
            <TabsTrigger value="estimates">Estimates</TabsTrigger>
            <TabsTrigger value="spend">
              Spend and holds
              {reservations.awaitingApprovalCount > 0 ? (
                <Badge variant="outline" className="ml-2 text-meta">
                  {reservations.awaitingApprovalCount} awaiting approval
                </Badge>
              ) : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ceilings" className="space-y-6 pt-4">
            <CeilingsPanel
              budget={budget}
              projectId={projectId}
              onSaved={() => void load()}
            />
          </TabsContent>

          <TabsContent value="estimates" className="space-y-6 pt-4">
            <EstimatesPanel
              projectId={projectId}
              budget={budget}
              defaultTaskKind={state.estimateTaskKind as TaskKind}
            />
          </TabsContent>

          <TabsContent value="spend" className="space-y-6 pt-4">
            <SpendPanel
              spend={spend}
              reservations={reservations.reservations}
              awaitingApprovalCount={reservations.awaitingApprovalCount}
              projectId={projectId}
              onChanged={() => void load()}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ── Ceilings ────────────────────────────────────────────────────────────

function CeilingsPanel({
  budget,
  projectId,
  onSaved,
}: {
  budget: BudgetView;
  projectId: string;
  onSaved: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-4">
      {budget.notes.length > 0 ? (
        <Alert>
          <Info aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>How these numbers were arrived at</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {budget.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {budget.operationCeilingsExcluded ? (
        <Alert>
          <AlertDescription>{budget.operationCeilingsExcluded}</AlertDescription>
        </Alert>
      ) : null}

      {budget.unboundedUnits.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>
            Unbounded: {budget.unboundedUnits.map((unit) => UNIT_LABEL[unit] ?? unit).join(', ')}
          </AlertTitle>
          <AlertDescription>
            No policy sets a ceiling in that unit, so work in it is unbounded —
            which is not the same as within budget. A per-run dollar cap is
            reported separately below.
          </AlertDescription>
        </Alert>
      ) : null}

      {budget.unresolvedPolicies.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>
            {budget.unresolvedPolicies.length} polic
            {budget.unresolvedPolicies.length === 1 ? 'y' : 'ies'} could not be measured
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {budget.unresolvedPolicies.map((policy) => (
                <li key={policy.policyId}>
                  <span className="font-mono text-meta">{policy.policyId}</span> ({policy.scopeType}, {policy.period}) — {policy.reason}
                </li>
              ))}
            </ul>
            A reservation against an unmeasurable window is refused rather than
            charged against a guessed one.
          </AlertDescription>
        </Alert>
      ) : null}

      {budget.activeCycle ? (
        <p className="text-meta text-muted-foreground">
          Active cycle <strong>{budget.activeCycle.name}</strong>:{' '}
          <Timestamp value={budget.activeCycle.startsOn} dateOnly /> –{' '}
          <Timestamp value={budget.activeCycle.endsOn} dateOnly />. Cycle-period
          ceilings are measured over this window.
        </p>
      ) : null}

      {budget.policies.length === 0 ? (
        <EmptyState
          variant="not-measured"
          subject="budget ceilings"
          prerequisite="A policy written here, or a client-level ceiling on the owning client."
        >
          No policy applies to this project, so no ceiling was evaluated. Work is
          unbounded, not budgeted.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {budget.policies.map((policy) => (
            <Card key={policy.policyId}>
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-table font-medium">
                      {policy.scopeType === 'client'
                        ? 'Client ceiling'
                        : policy.scopeType === 'operation'
                          ? `Operation ceiling · ${policy.taskKind}`
                          : 'Project ceiling'}
                    </CardTitle>
                    <p className="mt-1 font-mono text-meta text-muted-foreground">
                      {policy.policyId}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      label={policy.enforcement === 'hard' ? 'Hard cap' : 'Soft cap'}
                      tone={policy.enforcement === 'hard' ? 'danger' : 'warning'}
                    />
                    {policy.exceeded ? (
                      <StatusPill label="Exceeded" tone="danger" />
                    ) : (
                      <StatusPill label="Within ceiling" tone="success" />
                    )}
                  </div>
                </div>
                <p className="text-meta text-muted-foreground">
                  Window <strong>{policy.window.period}</strong> ·{' '}
                  {policy.window.resolved === 'all-time'
                    ? 'all time'
                    : policy.window.resolved === 'unresolved'
                      ? `unresolved — ${policy.window.unresolvedReason ?? 'no reason given'}`
                      : `${policy.window.startsAt ? new Date(policy.window.startsAt).toISOString().slice(0, 10) : '—'} to ${policy.window.endsAt ? new Date(policy.window.endsAt).toISOString().slice(0, 10) : '—'}`}{' '}
                  · measured in {policy.window.timezone}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-3">
                  {policy.totals.map((total) => (
                    <UnitRow key={total.unit} total={total} />
                  ))}
                </div>
                {policy.perRunCapUsd !== null ? (
                  <>
                    <Separator />
                    <p className="text-table">
                      Per-run dollar cap:{' '}
                      <strong>{formatCurrency(policy.perRunCapUsd, 'USD')}</strong> — checked
                      against the high end of an estimate, and never approvable.
                    </p>
                  </>
                ) : (
                  <>
                    <Separator />
                    <p className="text-table text-muted-foreground">
                      No per-run dollar cap on this policy. {notMeasuredLabel()} for a
                      single run&rsquo;s ceiling — that is different from a cap of zero.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-table font-medium">
            {dialogOpen ? 'Write a ceiling' : 'Change a ceiling'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!dialogOpen ? (
            <>
              <p className="text-table text-muted-foreground">
                Writing a ceiling replaces the existing policy for the same scope
                and period, or creates one. A policy must cap at least one of
                dollars, credits or a single run; a policy that caps nothing
                would be reported as bounded for work that is not.
              </p>
              <Button onClick={() => setDialogOpen(true)}>
                <CircleDollarSign aria-hidden="true" className="mr-2 h-4 w-4" />
                Write or replace a ceiling
              </Button>
            </>
          ) : (
            <CeilingForm
              projectId={projectId}
              onCancel={() => setDialogOpen(false)}
              onSaved={() => {
                setDialogOpen(false);
                onSaved();
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One unit's usage against one ceiling.
 *
 * The whole point of this row is that `held` and `settled` are two columns and
 * never one number: a reservation is set aside, not spent.
 */
function UnitRow({ total }: { total: UnitTotal }) {
  const isCredits = total.unit === 'credits';
  const format = (value: number) =>
    isCredits ? formatCredits(value) : formatCurrency(value, 'USD');

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isCredits ? (
            <Coins aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          ) : (
            <CircleDollarSign aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-table font-medium">{UNIT_LABEL[total.unit] ?? total.unit}</span>
        </div>
        {total.overLimit === null ? (
          <StatusPill label="No ceiling in this unit" tone="unmeasured" />
        ) : total.overLimit ? (
          <StatusPill label="Over its ceiling" tone="danger" />
        ) : (
          <StatusPill label="Within its ceiling" tone="success" />
        )}
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-4">
        <div>
          <dt className="text-meta text-muted-foreground">Ceiling</dt>
          <dd className="text-table tabular-nums">
            {total.limit === null ? 'No ceiling set' : format(total.limit)}
          </dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Held (not spent)</dt>
          <dd className="text-table tabular-nums">{format(total.reservedHeld)}</dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Settled actual</dt>
          <dd className="text-table tabular-nums">{format(total.settled)}</dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Remaining</dt>
          <dd className="text-table tabular-nums">
            {total.remaining === null ? 'Nothing to report — no ceiling' : format(total.remaining)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function CeilingForm({
  projectId,
  onCancel,
  onSaved,
}: {
  projectId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<string>('project');
  const [period, setPeriod] = useState<string>('month');
  const [enforcement, setEnforcement] = useState<string>('hard');
  const [limitUsd, setLimitUsd] = useState('');
  const [limitCredits, setLimitCredits] = useState('');
  const [perRunCapUsd, setPerRunCapUsd] = useState('');
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  const capsSomething =
    limitUsd.trim() !== '' || limitCredits.trim() !== '' || perRunCapUsd.trim() !== '';

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await putBudgetPolicy(projectId, {
        taskKind: scope === 'project' ? undefined : (scope as TaskKind),
        limitUsd: limitUsd.trim() === '' ? null : Number(limitUsd),
        limitCredits: limitCredits.trim() === '' ? null : Number(limitCredits),
        perRunCapUsd: perRunCapUsd.trim() === '' ? null : Number(perRunCapUsd),
        period: period as (typeof BUDGET_PERIODS)[number],
        enforcement: enforcement as (typeof BUDGET_ENFORCEMENTS)[number],
      });
      onSaved();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error ? (
        <ErrorState
          error={error}
          layout="inline"
          fieldIdPrefix="budget-policy-"
          preserveNotice="The values you entered are still on this page."
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="budget-policy-scope">Applies to</Label>
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger id="budget-policy-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">This project — every kind of work</SelectItem>
              {TASK_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  One operation only: {kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-meta text-muted-foreground">
            A client-scoped ceiling is shown here read-only when it applies: no
            route in this build writes one, so a client ceiling that exists was
            created outside this screen and cannot be edited from it.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="budget-policy-period">Window</Label>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger id="budget-policy-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUDGET_PERIODS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option === 'cycle'
                    ? 'The project’s live cycle'
                    : option === 'total'
                      ? 'All time — no window'
                      : `Per ${option}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-meta text-muted-foreground">
            A cycle window is refused at reserve time if the project has no live
            cycle — it is never charged against a guessed window.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="budget-policy-enforcement">When the ceiling is reached</Label>
          <Select value={enforcement} onValueChange={setEnforcement}>
            <SelectTrigger id="budget-policy-enforcement">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hard">Hard — the reservation is refused</SelectItem>
              <SelectItem value="soft">Soft — held, unapproved, pending a human</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="budget-policy-limitUsd">Dollar ceiling</Label>
          <Input
            id="budget-policy-limitUsd"
            type="number"
            min={0}
            step="0.01"
            value={limitUsd}
            onChange={(event) => setLimitUsd(event.target.value)}
            placeholder="Leave blank for no dollar ceiling"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="budget-policy-limitCredits">Credit ceiling</Label>
          <Input
            id="budget-policy-limitCredits"
            type="number"
            min={0}
            step="1"
            value={limitCredits}
            onChange={(event) => setLimitCredits(event.target.value)}
            placeholder="Leave blank for no credit ceiling"
          />
          {/* Stated in text: credits are a different unit from dollars. */}
          <p className="text-meta text-muted-foreground">
            Provider credits. This is a separate unit from dollars and is never
            converted to one here.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="budget-policy-perRunCapUsd">Per-run dollar cap</Label>
          <Input
            id="budget-policy-perRunCapUsd"
            type="number"
            min={0}
            step="0.01"
            value={perRunCapUsd}
            onChange={(event) => setPerRunCapUsd(event.target.value)}
            placeholder="Leave blank for no per-run cap"
          />
          <p className="text-meta text-muted-foreground">
            Checked against the high end of an estimate, and never approvable.
          </p>
        </div>
      </div>

      {!capsSomething ? (
        <Alert>
          <ShieldQuestion aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>This policy would cap nothing</AlertTitle>
          <AlertDescription>
            At least one of a dollar ceiling, a credit ceiling or a per-run cap
            is required. The server refuses an empty policy (409) because it
            would otherwise be reported as bounded work that is not bounded.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !capsSomething}>
          {busy ? 'Writing…' : 'Write ceiling'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <p className="text-meta text-muted-foreground">
          Writing replaces the existing policy for the same scope and period.
        </p>
      </div>
    </form>
  );
}

// ── Estimates ───────────────────────────────────────────────────────────

function EstimatesPanel({
  projectId,
  budget,
  defaultTaskKind,
}: {
  projectId: string;
  budget: BudgetView;
  defaultTaskKind: TaskKind;
}) {
  const [taskKind, setTaskKind] = useState<string>(defaultTaskKind);
  const [prompts, setPrompts] = useState('');
  const [runCount, setRunCount] = useState('');
  const [markets, setMarkets] = useState('');
  const [checkBalance, setCheckBalance] = useState(false);
  const [result, setResult] = useState<CostEstimateView | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  async function onEstimate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await createCostEstimate(projectId, {
          taskKind: taskKind as TaskKind,
          prompts: prompts.trim() === '' ? undefined : Number(prompts),
          runCount: runCount.trim() === '' ? undefined : Number(runCount),
          markets: markets.trim() === '' ? undefined : Number(markets),
          checkProviderBalance: checkBalance,
        }),
      );
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-table font-medium">Pre-flight estimate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            An estimate is not a charge and not a reservation. It reserves
            nothing, and settlement is recorded separately and compared against
            it in the spend ledger.
          </p>

          <form onSubmit={onEstimate} className="space-y-4">
            {error ? <ErrorState error={error} layout="inline" /> : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="estimate-taskKind">Kind of work</Label>
                <Select value={taskKind} onValueChange={setTaskKind}>
                  <SelectTrigger id="estimate-taskKind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {kind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-meta text-muted-foreground">
                  Only answer-engine sampling has a tariff in this build. Every
                  other kind answers with an explicit &ldquo;no estimator
                  exists&rdquo; rather than a zero.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="estimate-prompts">Prompts</Label>
                <Input
                  id="estimate-prompts"
                  type="number"
                  min={0}
                  value={prompts}
                  onChange={(event) => setPrompts(event.target.value)}
                  placeholder="Use the tariff default"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="estimate-runCount">Repeats per prompt</Label>
                <Input
                  id="estimate-runCount"
                  type="number"
                  min={1}
                  max={100}
                  value={runCount}
                  onChange={(event) => setRunCount(event.target.value)}
                  placeholder="Use the tariff default"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="estimate-markets">Markets</Label>
                <Input
                  id="estimate-markets"
                  type="number"
                  min={1}
                  max={50}
                  value={markets}
                  onChange={(event) => setMarkets(event.target.value)}
                  placeholder="Use the tariff default"
                />
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Switch
                id="estimate-checkBalance"
                checked={checkBalance}
                onCheckedChange={setCheckBalance}
              />
              <div>
                <Label htmlFor="estimate-checkBalance" className="text-table">
                  Also read the provider balance
                </Label>
                <p className="text-meta text-muted-foreground">
                  Off by default. When off, the balance is reported as{' '}
                  <strong>unknown</strong> — which is not the same as
                  affordable, and never rendered as if it were.
                </p>
              </div>
            </div>

            <Button type="submit" disabled={busy}>
              {busy ? 'Estimating…' : 'Estimate this run'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result ? (
        <EstimateResult result={result} />
      ) : (
        <Card>
          <CardContent className="pt-4">
            <p className="text-table text-muted-foreground">
              No estimate has been requested in this session. The ceilings below
              are already evaluated and unchanged by an estimate.
            </p>
            <div className="mt-3 space-y-2">
              {budget.bindingCeilings.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  No binding ceiling — no policy caps any unit for this project.
                </p>
              ) : (
                budget.bindingCeilings.map((ceiling) => (
                  <p key={`${ceiling.policyId}-${ceiling.unit}`} className="text-table">
                    {UNIT_LABEL[ceiling.unit] ?? ceiling.unit}: ceiling{' '}
                    <strong>
                      {ceiling.unit === 'credits'
                        ? formatCredits(ceiling.limit)
                        : formatCurrency(ceiling.limit, 'USD')}
                    </strong>
                    , remaining{' '}
                    <strong>
                      {ceiling.unit === 'credits'
                        ? formatCredits(ceiling.remaining)
                        : formatCurrency(ceiling.remaining, 'USD')}
                    </strong>
                  </p>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const AFFORDABILITY_TONE: Record<string, StatusTone> = {
  affordable: 'success',
  'over-cap': 'danger',
  'requires-approval': 'warning',
  unknown: 'unmeasured',
};

const AFFORDABILITY_LABEL: Record<string, string> = {
  affordable: 'Affordable under the current ceilings',
  'over-cap': 'Over a ceiling',
  'requires-approval': 'Within a ceiling, but needs approval',
  unknown: 'Unknown — the balance could not be read',
};

function EstimateResult({ result }: { result: CostEstimateView }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardTitle className="text-table font-medium">
              Estimate for {result.taskKind}
            </CardTitle>
            <StatusPill
              label={AFFORDABILITY_LABEL[result.affordability.state] ?? result.affordability.state}
              tone={AFFORDABILITY_TONE[result.affordability.state] ?? 'unmeasured'}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table">{result.affordability.reason}</p>

          {result.affordability.shortfallUnits.length > 0 ? (
            <p className="text-table">
              Over the ceiling in:{' '}
              {[...new Set(result.affordability.shortfallUnits)]
                .map((unit) => UNIT_LABEL[unit] ?? unit)
                .join(', ')}
              .
            </p>
          ) : null}

          {!result.estimate.available ? (
            <Alert variant="destructive" role="alert">
              <Ban aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>No estimator exists for this kind of work</AlertTitle>
              <AlertDescription>
                {result.estimate.reason ??
                  'The server did not say why, which is itself worth reporting.'}{' '}
                This is not a zero estimate.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="space-y-3">
                {/* One row per unit. There is deliberately no total. */}
                {result.estimate.ranges.map((range) => (
                  <div
                    key={`${range.unit}-${range.caller}-${range.basis}`}
                    className="rounded-md border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-table font-medium">
                        {UNIT_LABEL[range.unit] ?? range.unit}
                      </span>
                      <span className="text-table tabular-nums font-semibold">
                        {range.rangeKind === 'point'
                          ? range.unit === 'credits'
                            ? formatCredits(range.low)
                            : formatCurrency(range.low, 'USD')
                          : `${range.unit === 'credits' ? formatCredits(range.low) : formatCurrency(range.low, 'USD')} – ${range.unit === 'credits' ? formatCredits(range.high) : formatCurrency(range.high, 'USD')}`}
                      </span>
                    </div>
                    <p className="mt-1 text-meta text-muted-foreground">
                      Basis: {range.basis} · {range.basisDetail}
                    </p>
                    <p className="text-meta text-muted-foreground">
                      Estimate basis: {range.caller}
                    </p>
                  </div>
                ))}
              </div>

              {result.estimate.conversion ? (
                <Alert>
                  <Info aria-hidden="true" className="h-4 w-4" />
                  <AlertTitle>
                    Reported conversion — not part of the credit figure
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      {formatCredits(result.estimate.conversion.convertedLow)} –{' '}
                      {formatCredits(result.estimate.conversion.convertedHigh)} credits is{' '}
                      <strong>
                        {formatCurrency(result.estimate.conversion.convertedLow, 'USD')} –{' '}
                        {formatCurrency(result.estimate.conversion.convertedHigh, 'USD')}
                      </strong>{' '}
                      at a rate of {result.estimate.conversion.rate} from{' '}
                      <code className="font-mono">{result.estimate.conversion.rateEnvVar}</code>.
                    </p>
                    <p className="mt-1">{result.estimate.conversion.caveat}</p>
                    <p className="mt-1">
                      The credit figure above is the estimate. This conversion is
                      reported beside it and is never added to it.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : null}

              {result.estimate.assumedDefaults ? (
                <p className="text-meta text-muted-foreground">
                  Some inputs were not supplied, so the tariff&rsquo;s documented
                  defaults were assumed and are disclosed here rather than
                  silently applied.
                </p>
              ) : null}
            </>
          )}

          <Separator />

          <div>
            <h4 className="text-table font-medium">Provider balances</h4>
            {result.providerBalances.length === 0 ? (
              <p className="mt-1 text-table text-muted-foreground">
                No provider balance was read for this estimate. Unknown — not
                assumed to fit.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {result.providerBalances.map((balance, index) => (
                  <ProviderBalanceRow key={index} balance={balance} />
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="text-table font-medium">Reservation required</h4>
            <p className="mt-1 text-table">{result.reservationRationale}</p>
          </div>

          {result.notes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4 text-meta text-muted-foreground">
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A balance is either a number we read, with its unit and source, or an
 * explicit unknown carrying a reason. There is no branch in which an absent
 * balance reads as sufficient.
 */
function ProviderBalanceRow({ balance }: { balance: ProviderBalance }) {
  if (balance.state === 'unknown') {
    return (
      <li className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-table font-medium">Provider balance</span>
          <StatusPill label="Unknown" tone="unmeasured" />
        </div>
        <p className="mt-1 text-table">{balance.reason}</p>
        <p className="mt-1 text-meta text-muted-foreground">
          An unknown balance is not an affirmation that the work fits. Decide
          explicitly.
        </p>
      </li>
    );
  }
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-table font-medium">Provider balance</span>
        <span className="text-table tabular-nums font-semibold">
          {balance.unit === 'credits'
            ? formatCredits(balance.value)
            : formatCurrency(balance.value, 'USD')}
        </span>
      </div>
      <p className="mt-1 text-meta text-muted-foreground">
        Read from {balance.source} · <Timestamp value={balance.readAt} />
      </p>
    </li>
  );
}

// ── Spend and holds ─────────────────────────────────────────────────────

function SpendPanel({
  spend,
  reservations,
  awaitingApprovalCount,
  projectId,
  onChanged,
}: {
  spend: SpendView;
  reservations: ReservationView[];
  awaitingApprovalCount: number;
  projectId: string;
  onChanged: () => void;
}) {
  const [actionError, setActionError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [settling, setSettling] = useState<ReservationView | null>(null);

  const awaiting = reservations.filter((reservation) => reservation.awaitingApproval);

  const eventColumns = useMemo<ReadonlyArray<ColumnDef<SpendView['events'][number]>>>(
    () => [
      {
        key: 'occurredAt',
        header: 'When',
        accessor: (row) => row.occurredAt,
        sortable: true,
        width: 200,
        render: (row) => <Timestamp value={row.occurredAt} />,
      },
      {
        key: 'provider',
        header: 'Provider',
        accessor: (row) => row.provider,
        sortable: true,
      },
      {
        key: 'taskKind',
        header: 'Work',
        accessor: (row) => row.taskKind ?? '',
        render: (row) =>
          row.taskKind ?? <span className="text-muted-foreground">Not recorded</span>,
      },
      {
        key: 'amount',
        header: 'Actual charge',
        accessor: (row) => row.amount,
        sortable: true,
        align: 'right',
        width: 160,
        render: (row) => (
          <span className="tabular-nums">
            {row.unit === 'credits' ? formatCredits(row.amount) : formatCurrency(row.amount, 'USD')}
          </span>
        ),
      },
      {
        key: 'unit',
        header: 'Unit',
        accessor: (row) => row.unit,
        width: 100,
        render: (row) => <Badge variant="outline">{row.unit}</Badge>,
      },
      {
        key: 'attribution',
        header: 'Attributed to',
        accessor: (row) => row.reservationId ?? row.jobRunId ?? '',
        render: (row) => (
          <span className="font-mono text-meta">
            {row.reservationId
              ? `reservation ${row.reservationId}`
              : row.jobRunId
                ? `run ${row.jobRunId}`
                : 'unattributed'}
          </span>
        ),
      },
      {
        key: 'note',
        header: 'Note',
        accessor: (row) => row.note ?? '',
        render: (row) =>
          row.note ?? <span className="text-muted-foreground">No note recorded</span>,
      },
    ],
    [],
  );

  const reservationColumns = useMemo<ReadonlyArray<ColumnDef<ReservationView>>>(
    () => [
      {
        key: 'createdAt',
        header: 'Held since',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 200,
        render: (row) => <Timestamp value={row.createdAt} />,
      },
      {
        key: 'taskKind',
        header: 'Work',
        accessor: (row) => row.taskKind,
        sortable: true,
      },
      {
        key: 'reserved',
        header: 'Held',
        accessor: (row) => row.reserved.usd,
        sortable: true,
        render: (row) => (
          <div className="text-table tabular-nums">
            {row.reserved.usd > 0 ? <div>{formatCurrency(row.reserved.usd, 'USD')}</div> : null}
            {row.reserved.credits > 0 ? <div>{formatCredits(row.reserved.credits)}</div> : null}
            {row.reserved.usd === 0 && row.reserved.credits === 0 ? (
              <span className="text-muted-foreground">Nothing set aside</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'settled',
        header: 'Settled actual',
        accessor: (row) => row.settled?.usd ?? null,
        sortable: true,
        emptyLabel: 'Not settled',
        render: (row) =>
          row.settled ? (
            <div className="text-table tabular-nums">
              {row.settled.usd > 0 ? <div>{formatCurrency(row.settled.usd, 'USD')}</div> : null}
              {row.settled.credits > 0 ? <div>{formatCredits(row.settled.credits)}</div> : null}
            </div>
          ) : null,
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        sortable: true,
        width: 150,
        render: (row) => (
          <StatusPill
            label={row.expiredButUnswept ? `${row.status} (lapsed)` : row.status}
            tone={reservationTone(row)}
          />
        ),
      },
      {
        key: 'approval',
        header: 'Approval',
        accessor: (row) => (row.awaitingApproval ? 'awaiting' : row.approvedBy ? 'approved' : 'not-required'),
        width: 160,
        render: (row) =>
          row.awaitingApproval ? (
            <StatusPill label="Awaiting approval" tone="warning" />
          ) : row.approvedBy ? (
            <span className="text-meta text-muted-foreground">
              Approved by <span className="font-mono">{row.approvedBy}</span>
            </span>
          ) : (
            <span className="text-meta text-muted-foreground">Within policy</span>
          ),
      },
      {
        key: 'variance',
        header: 'Estimate vs actual',
        accessor: (row) => row.variance?.vsHighUsd ?? null,
        emptyLabel: 'No comparison until settled',
        render: (row) =>
          row.variance ? (
            <div className="text-table">
              <div className="tabular-nums">
                {row.variance.vsHighUsd > 0 ? '+' : ''}
                {formatCurrency(row.variance.vsHighUsd, 'USD')} vs high,{' '}
                {row.variance.vsLowUsd > 0 ? '+' : ''}
                {formatCurrency(row.variance.vsLowUsd, 'USD')} vs low
              </div>
              <div className="text-meta text-muted-foreground">{row.variance.note}</div>
            </div>
          ) : null,
      },
    ],
    [],
  );

  async function runAction(reservation: ReservationView, action: 'approve' | 'release') {
    setBusyId(reservation.id);
    setActionError(null);
    try {
      if (action === 'approve') await approveReservation(projectId, reservation.id);
      else await releaseReservation(projectId, reservation.id);
      onChanged();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {actionError ? (
        <ErrorState error={actionError} layout="inline" />
      ) : null}

      {/*
        Totals per unit, rendered side by side and never combined. The two rows
        are the API's own output, not a reduction this screen performs.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        {spend.totals.map((total) => (
          <Card key={total.unit}>
            <CardHeader>
              <CardTitle className="text-table font-medium">
                {UNIT_LABEL[total.unit] ?? total.unit}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div>
                <p className="text-meta text-muted-foreground">
                  Settled actual {total.unit === 'credits' ? '(credits)' : '(USD)'}
                </p>
                <p className="text-subsection tabular-nums font-semibold">
                  {total.unit === 'credits'
                    ? formatCredits(total.settled)
                    : formatCurrency(total.settled, 'USD')}
                </p>
              </div>
              <div>
                <p className="text-meta text-muted-foreground">Held, not spent</p>
                <p className="text-table tabular-nums">
                  {total.unit === 'credits'
                    ? formatCredits(total.reservedHeld)
                    : formatCurrency(total.reservedHeld, 'USD')}
                </p>
              </div>
              <p className="text-meta text-muted-foreground">
                {UNIT_LABEL[total.unit]} and the other unit are never added
                together; there is no single total spend figure.
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-table font-medium">Reservation states</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
            <Count label="Held" value={spend.reservationSummary.held} />
            <Count label="Settled" value={spend.reservationSummary.settled} />
            <Count label="Released" value={spend.reservationSummary.released} />
            <Count label="Expired" value={spend.reservationSummary.expired} />
            <Count label="Awaiting approval" value={spend.reservationSummary.awaitingApproval} />
            <Count label="Lapsed on this read" value={spend.reservationSummary.expiredOnThisRead} />
          </dl>
          <p className="text-meta text-muted-foreground">
            {spend.window.note}
          </p>
          <p className="text-meta text-muted-foreground">{spend.balanceProbe.reason}</p>
        </CardContent>
      </Card>

      {awaitingApprovalCount > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">
              Approval queue ({awaitingApprovalCount})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-table text-muted-foreground">
              These holds passed a <strong>soft</strong> ceiling. They already
              count against it and cannot be settled until an approving role
              confirms them. A hard ceiling never reaches this queue — it was
              refused when the reservation was made.
            </p>
            {awaiting.map((reservation) => (
              <div
                key={reservation.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div>
                  <p className="text-table font-medium">{reservation.taskKind}</p>
                  <p className="text-meta text-muted-foreground">
                    Held {formatCurrency(reservation.reserved.usd, 'USD')}
                    {reservation.reserved.credits > 0
                      ? ` and ${formatCredits(reservation.reserved.credits)}`
                      : ''}{' '}
                    since <Timestamp value={reservation.createdAt} />
                    {reservation.expiresAt ? (
                      <>
                        {' · expires '}
                        <Timestamp value={reservation.expiresAt} />
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busyId === reservation.id}
                    onClick={() => void runAction(reservation, 'approve')}
                  >
                    Approve overage
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === reservation.id}
                    onClick={() => void runAction(reservation, 'release')}
                  >
                    Release hold
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3" aria-labelledby="spend-events">
        <h2 id="spend-events" className="text-subsection font-semibold">
          Cost audit ledger
        </h2>
        <p className="text-table text-muted-foreground">
          Actual charges, newest first. A charge with no reservation or run cannot
          be de-duplicated against a retry, so the server refuses to record one
          — every row here is attributable.
        </p>
        <DataTable
          caption="Spend events"
          columns={eventColumns}
          rows={spend.events}
          getRowId={(row) => row.id}
          minTableWidth="60rem"
          defaultSort={{ key: 'occurredAt', direction: 'desc' }}
          emptyState={
            <EmptyState
              variant="not-measured"
              subject="recorded charges"
              prerequisite="A settled reservation, or a directly recorded charge with a reservation or run id."
            />
          }
        />
      </section>

      <section className="space-y-3" aria-labelledby="spend-reservations">
        <h2 id="spend-reservations" className="text-subsection font-semibold">
          Holds
        </h2>
        <p className="text-table text-muted-foreground">
          Reservations, newest first. A hold stops counting against the ceiling
          when it is released, expires or is settled.
        </p>
        <DataTable
          caption="Spend reservations"
          columns={reservationColumns}
          rows={reservations}
          getRowId={(row) => row.id}
          minTableWidth="72rem"
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          rowDetail={(row) => (
            <div className="space-y-3">
              <dl className="grid gap-x-6 gap-y-2 text-meta sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Reservation id</dt>
                  <dd className="font-mono">{row.id}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Job run</dt>
                  <dd className="font-mono">{row.jobRunId ?? 'Not linked to a run'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Estimate range</dt>
                  <dd className="tabular-nums">
                    {formatCurrency(row.estimate.lowUsd, 'USD')} –{' '}
                    {formatCurrency(row.estimate.highUsd, 'USD')}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Requested by</dt>
                  <dd className="font-mono">{row.requestedBy ?? 'Not recorded'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Settled at</dt>
                  <dd>{row.settledAt ? <Timestamp value={row.settledAt} /> : 'Not settled'}</dd>
                </div>
              </dl>
              {row.status === 'held' ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!row.approvedBy && row.awaitingApproval}
                    onClick={() => setSettling(row)}
                  >
                    Record what was charged
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === row.id}
                    onClick={() => void runAction(row, 'release')}
                  >
                    Release this hold
                  </Button>
                  {row.awaitingApproval ? (
                    <p className="text-meta text-muted-foreground">
                      Settling is blocked until the overage is approved — the
                      server refuses it (409) rather than charging an unapproved
                      overrun.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-meta text-muted-foreground">
                  This reservation is {row.status}. Settling an already-settled
                  hold is refused rather than charging twice.
                </p>
              )}
            </div>
          )}
          emptyState={
            <EmptyState
              variant="not-measured"
              subject="spend reservations"
              prerequisite="Work that reserves before a run starts. Nothing has been held against this project."
            />
          }
        />
      </section>

      {settling ? (
        <SettleForm
          projectId={projectId}
          reservation={settling}
          onCancel={() => setSettling(null)}
          onSettled={() => {
            setSettling(null);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="text-table tabular-nums font-medium">{value}</dd>
    </div>
  );
}

function reservationTone(reservation: ReservationView): StatusTone {
  if (reservation.status === 'settled') return 'success';
  if (reservation.status === 'held') return reservation.awaitingApproval ? 'warning' : 'info';
  if (reservation.status === 'expired') return 'unmeasured';
  return 'neutral';
}

function SettleForm({
  projectId,
  reservation,
  onCancel,
  onSettled,
}: {
  projectId: string;
  reservation: ReservationView;
  onCancel: () => void;
  onSettled: () => void;
}) {
  const [usd, setUsd] = useState('');
  const [credits, setCredits] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  const reportedUsd = usd.trim() === '' ? undefined : Number(usd);
  const overReserved =
    reportedUsd !== undefined && reportedUsd > reservation.reserved.usd;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await settleReservation(projectId, reservation.id, {
        settledUsd: reportedUsd,
        settledCredits: credits.trim() === '' ? undefined : Number(credits),
        acknowledgeOverReservation: overReserved ? acknowledge : undefined,
      });
      onSettled();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-table font-medium">
          Record the actual charge
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <ErrorState
              error={error}
              layout="inline"
              fieldIdPrefix="settle-"
              preserveNotice="Nothing you typed has been cleared."
            />
          ) : null}

          <p className="text-table text-muted-foreground">
            Held was {formatCurrency(reservation.reserved.usd, 'USD')}
            {reservation.reserved.credits > 0
              ? ` and ${formatCredits(reservation.reserved.credits)}`
              : ''}
            . Settling writes the actual charge exactly once; a second attempt is
            refused rather than charged again.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="settle-usd">Actual charge in USD</Label>
              <Input
                id="settle-usd"
                type="number"
                min={0}
                step="0.01"
                value={usd}
                onChange={(event) => setUsd(event.target.value)}
                placeholder="Leave blank if this was not billed in dollars"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settle-credits">Actual charge in credits</Label>
              <Input
                id="settle-credits"
                type="number"
                min={0}
                step="1"
                value={credits}
                onChange={(event) => setCredits(event.target.value)}
                placeholder="Leave blank if this was not billed in credits"
              />
              {/* Separate fields, deliberately: one unit is never inferred. */}
              <p className="text-meta text-muted-foreground">
                A charge reported only in credits writes a credit event and no
                invented dollar figure. The two are separate units and neither is
                derived from the other.
              </p>
            </div>
          </div>

          {overReserved ? (
            <div className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning-subtle p-3">
              <Switch
                id="settle-acknowledge"
                checked={acknowledge}
                onCheckedChange={setAcknowledge}
              />
              <div>
                <Label htmlFor="settle-acknowledge" className="text-table">
                  Acknowledge that this exceeds what was held
                </Label>
                <p className="text-meta text-muted-foreground">
                  {formatCurrency(Number(usd), 'USD')} is more than the{' '}
                  {formatCurrency(reservation.reserved.usd, 'USD')} set aside. The
                  server refuses the overrun without this acknowledgement.
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || (usd.trim() === '' && credits.trim() === '')}>
              {busy ? 'Recording…' : 'Record the charge'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
