'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, Check } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { RunConfigurator } from '@/components/patterns/RunConfigurator';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatCredits, formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import type { RunEstimate } from '@/types';
import { getProjectDetail, type ProjectDetailWire } from '@/services/projects';
import {
  AEO_ACTIVE_STATUSES,
  AEO_MATRIX_TIERS,
  AEO_MAX_RUN_COUNT,
  AEO_MIN_RUN_COUNT,
  AEO_SURFACES,
  AEO_SURFACE_LABELS,
  createAeoAuditDraft,
  estimateAeoBudget,
  getSiteContext,
  listAeoAudits,
  runFullAeoAudit,
  type AeoBudgetEstimate,
  type AuditRunSummary,
  type SiteContext,
} from '@/services/research';

/**
 * AE02 — AI run setup. **This is the one screen in this package that spends
 * money**, so §10.4's scan/generation row is the acceptance criteria:
 * *prerequisites, scope/cost, explicit start, double-submit protection,
 * timeout reconciliation.*
 *
 * What that means concretely here:
 *
 *  1. **The estimate is fetched before the start, and from the API.** Engines,
 *     tier, repeats and markets are chosen in the configuration card; every
 *     change re-asks `GET /aeo/budget` for the credit cost of *that*
 *     configuration. Credits are never converted to money and never shown as
 *     money (§6.3) — there is no currency in this screen at all.
 *  2. **The planned volume is stated as arithmetic, not as a promise.**
 *     `prompts × repeats × engines × markets` is the number of answer calls the
 *     run schedules; a run that returns fewer answers reports thin coverage in
 *     AE03, and this screen does not imply otherwise.
 *  3. **Start is inside `RunConfigurator`**, which owns the ref guard, keeps the
 *     button disabled after acceptance, and never retries a lost response. The
 *     "Save as draft" action is a *separate* control that creates the audit row
 *     with no spend — which is the honest half of the plan's "start or draft".
 */

/** Empty means "let the server derive it from the site context". */
const MARKET_PATTERN = /^[A-Za-z]{2}$/;

function parseMarkets(raw: string): string[] {
  return raw
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
}

export default function NewAeoRunPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();

  const [project, setProject] = useState<ProjectDetailWire | null>(null);
  const [context, setContext] = useState<SiteContext | null>(null);
  const [audits, setAudits] = useState<AuditRunSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // ── The run configuration. Nothing here starts anything. ────────────────
  const [surfaces, setSurfaces] = useState<string[]>(['cloro-chatgpt']);
  const [tier, setTier] = useState('standard');
  const [runCount, setRunCount] = useState(AEO_MIN_RUN_COUNT);
  const [marketInput, setMarketInput] = useState('');

  const [estimate, setEstimate] = useState<AeoBudgetEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<ApiError | null>(null);
  const [estimating, setEstimating] = useState(false);

  const [draftError, setDraftError] = useState<ApiError | null>(null);
  const [draftInFlight, setDraftInFlight] = useState(false);
  /**
   * Set when the create request did not come back. The audit row may exist
   * anyway, so the control stays disabled and the operator is sent to the run
   * list to reconcile — §10.3 forbids blindly retrying a create, and a second
   * draft is a second stored audit.
   */
  const [draftOutcomeUnknown, setDraftOutcomeUnknown] = useState(false);
  // A ref, not state: two clicks in the same tick must not both pass.
  const draftGuard = useRef(false);
  const draftTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markets = useMemo(() => parseMarkets(marketInput), [marketInput]);
  const marketCount = Math.max(markets.length, 1);
  const prompts = AEO_MATRIX_TIERS.find((entry) => entry.tier === tier)?.prompts ?? null;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projectResult, contextResult, auditResult] = await Promise.all([
          getProjectDetail(projectId, { signal }),
          getSiteContext(projectId, { signal }),
          listAeoAudits(projectId, { signal }),
        ]);
        setProject(projectResult);
        setContext(contextResult);
        setAudits(auditResult.audits);
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

  /**
   * Re-asks the API for the cost of the configuration currently on screen.
   *
   * Debounced only to keep a burst of control changes from spending the
   * per-IP request budget — it is a read, and it never starts a run.
   */
  useEffect(() => {
    if (surfaces.length === 0) {
      setEstimate(null);
      setEstimateError(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setEstimating(true);
      estimateAeoBudget(
        projectId,
        { surfaces, tier, runCount, markets: marketCount },
        { signal: controller.signal },
      )
        .then((result) => {
          setEstimate(result);
          setEstimateError(null);
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setEstimate(null);
          setEstimateError(toApiError(caught));
        })
        .finally(() => setEstimating(false));
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, surfaces, tier, runCount, marketCount]);

  const runInFlight = useMemo(
    () => (audits ?? []).some((audit) => AEO_ACTIVE_STATUSES.includes(audit.status)),
    [audits],
  );

  const invalidMarkets = markets.filter((code) => !MARKET_PATTERN.test(code));
  const tooManyMarkets = markets.length > 5;

  /** The estimate in the shape `RunConfigurator` renders, with no currency. */
  const runEstimate: RunEstimate | undefined = estimate
    ? { requests: estimate.calls, costCredits: estimate.required }
    : undefined;

  const handleDraft = useCallback(async () => {
    if (draftGuard.current || draftOutcomeUnknown || runInFlight || surfaces.length === 0) return;
    draftGuard.current = true;
    setDraftInFlight(true);
    setDraftError(null);

    // A lost response is not a rejection: the row may have been written. The
    // guard below turns the timeout into an explicit "unknown" state instead of
    // a silent retry or a false "nothing happened".
    let settled = false;
    draftTimeout.current = setTimeout(() => {
      if (settled) return;
      settled = true;
      draftGuard.current = false;
      setDraftInFlight(false);
      setDraftOutcomeUnknown(true);
    }, 60_000);

    try {
      const draft = await createAeoAuditDraft(projectId, {
        surfaces,
        tier,
        runCount,
        markets: markets.length > 0 ? markets : undefined,
        reuseContext: true,
      });
      if (settled) return;
      settled = true;
      if (draftTimeout.current) clearTimeout(draftTimeout.current);
      router.push(`/projects/${projectId}/research/ai/runs/${draft.auditId}`);
    } catch (caught) {
      if (settled) return;
      settled = true;
      if (draftTimeout.current) clearTimeout(draftTimeout.current);
      const apiError = toApiError(caught);
      // A network failure means we do not know whether the row was written;
      // an HTTP error means the server told us it was not.
      if (apiError.kind === 'network') {
        setDraftOutcomeUnknown(true);
      } else {
        setDraftError(apiError);
      }
    } finally {
      if (!settled) {
        if (draftTimeout.current) clearTimeout(draftTimeout.current);
      }
      draftGuard.current = false;
      setDraftInFlight(false);
    }
  }, [projectId, surfaces, tier, runCount, markets, runInFlight, draftOutcomeUnknown, router]);

  useEffect(
    () => () => {
      if (draftTimeout.current) clearTimeout(draftTimeout.current);
    },
    [],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="New AI visibility run" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!project || !audits) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{ projectName: project.name, domain: project.domain, mode: 'live' }}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}/research/ai`}>Back to AI visibility</Link>
          </Button>
        }
      />

      <PageHeader
        title="New AI visibility run"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{project.domain}</span>
            <span>
              Site context:{' '}
              {context ? (
                <>
                  built <Timestamp value={context.createdAt} /> ({context.extraction.replace('-', ' ')})
                </>
              ) : (
                'not built'
              )}
            </span>
          </span>
        }
        status={
          runInFlight ? <StatusPill label="A run is already in progress" tone="info" /> : undefined
        }
      />

      {runInFlight ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>An AEO run is already in flight for this project</AlertTitle>
          <AlertDescription>
            Starting another one would queue a second paid run against the same matrix. Cailyx will not
            start it from here. Open the running audit to follow it or resume it.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── Configuration. A deliberate, explicit set of choices. ─────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Run configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 pt-2">
          <fieldset className="space-y-3">
            <legend className="text-table font-medium text-foreground">Answer engines</legend>
            <p className="text-meta text-muted-foreground">
              Every selected engine is queried with the same prompt matrix, which is what makes
              &ldquo;named on one engine, invisible on another&rdquo; a finding this run can produce. The
              <span className="font-mono"> cloro-* </span> surfaces are metered; the
              <span className="font-mono"> *-browser </span> surfaces are paid for by the operator&rsquo;s
              own subscription and report zero credits.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {AEO_SURFACES.map((surface) => {
                const checked = surfaces.includes(surface);
                return (
                  <div key={surface} className="flex items-center gap-2">
                    <Checkbox
                      id={`surface-${surface}`}
                      checked={checked}
                      onCheckedChange={(next) =>
                        setSurfaces((current) =>
                          next === true ? [...current, surface] : current.filter((s) => s !== surface),
                        )
                      }
                    />
                    <Label htmlFor={`surface-${surface}`} className="text-table font-normal">
                      {AEO_SURFACE_LABELS[surface] ?? surface}
                      {surface === 'mock' ? ' — test surface, never a real observation' : ''}
                    </Label>
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="tier">Prompt matrix size</Label>
              <Select value={tier} onValueChange={setTier}>
                <SelectTrigger id="tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AEO_MATRIX_TIERS.map((entry) => (
                    <SelectItem key={entry.tier} value={entry.tier}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                The matrix is generated by the orchestrator; a curated prompt set cannot be bound to a full
                run yet (design_plan G19).
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="runCount">Repeats per prompt</Label>
              <Input
                id="runCount"
                type="number"
                min={AEO_MIN_RUN_COUNT}
                max={AEO_MAX_RUN_COUNT}
                value={runCount}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setRunCount(Number.isFinite(next) ? next : AEO_MIN_RUN_COUNT);
                }}
                aria-describedby="runCount-help"
              />
              <p id="runCount-help" className="text-meta text-muted-foreground">
                {AEO_MIN_RUN_COUNT}–{AEO_MAX_RUN_COUNT}. The floor is {AEO_MIN_RUN_COUNT} and the API rejects
                anything lower — a rate over fewer than {AEO_MIN_RUN_COUNT} answers is not reported as a
                rate anywhere in Cailyx.
              </p>
              {runCount < AEO_MIN_RUN_COUNT || runCount > AEO_MAX_RUN_COUNT ? (
                <p className="text-meta text-danger-foreground">
                  Repeats must be between {AEO_MIN_RUN_COUNT} and {AEO_MAX_RUN_COUNT}; the server will reject
                  this value.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="markets">Markets</Label>
              <Input
                id="markets"
                value={marketInput}
                onChange={(event) => setMarketInput(event.target.value)}
                placeholder="US, GB — leave empty to use the site context"
                aria-describedby="markets-help"
              />
              <p id="markets-help" className="text-meta text-muted-foreground">
                ISO 3166-1 alpha-2 codes, up to five, comma-separated. Empty means the market is derived
                from the site context once the context loads.
              </p>
              {invalidMarkets.length > 0 ? (
                <p className="text-meta text-danger-foreground">
                  Not a two-letter country code: {invalidMarkets.join(', ')}.
                </p>
              ) : null}
              {tooManyMarkets ? (
                <p className="text-meta text-danger-foreground">
                  {markets.length} markets selected; the API accepts at most five.
                </p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── The planned volume, as arithmetic. ───────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Planned volume</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <dl className="grid gap-2 text-table sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Prompts in this tier</dt>
              <dd className="font-medium tabular-nums">
                {prompts === null ? notMeasuredLabel() : formatNumber(prompts)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Engines selected</dt>
              <dd className="font-medium tabular-nums">{formatNumber(surfaces.length)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Markets</dt>
              <dd className="font-medium tabular-nums">
                {markets.length > 0 ? `${formatNumber(markets.length)} (${markets.join(', ')})` : '1, derived from context'}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Repeats per prompt</dt>
              <dd className="font-medium tabular-nums">{formatNumber(runCount)}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:col-span-2">
              <dt className="text-muted-foreground">
                Scheduled answer calls (prompts × engines × markets × repeats)
              </dt>
              <dd className="font-semibold tabular-nums">
                {prompts === null || surfaces.length === 0
                  ? notMeasuredLabel()
                  : formatNumber(prompts * surfaces.length * marketCount * runCount)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-meta text-muted-foreground">
            This is the number of calls the run schedules, not the number of answers that will come back. A
            run whose engines fail part way returns fewer observations, and AE03 reports that coverage
            rather than a rate on its own.
          </p>
        </CardContent>
      </Card>

      {/* ── Cost. Credits only, and never a total that mixes units. ──────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Estimated cost before you start</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {estimateError ? (
            <ErrorState
              error={estimateError}
              layout="inline"
              onRetry={() => setEstimateError(null)}
              providerName="the credit meter"
              preserveNotice="You can still change the configuration; the estimate will be re-requested."
            />
          ) : estimating && !estimate ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : estimate ? (
            <>
              <dl className="grid gap-2 text-table sm:grid-cols-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Credits this configuration needs</dt>
                  <dd className="font-semibold tabular-nums">{formatCredits(estimate.required)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Estimated answer calls</dt>
                  <dd className="font-medium tabular-nums">{formatNumber(estimate.calls)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Allowance remaining</dt>
                  <dd className="font-medium tabular-nums">
                    {estimate.remaining === null ? notMeasuredLabel() : formatCredits(estimate.remaining)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Fits the remaining allowance</dt>
                  <dd className="font-medium">
                    {estimate.fits === null ? 'Unknown' : estimate.fits ? 'Yes' : 'No'}
                  </dd>
                </div>
              </dl>

              {estimate.remaining === null ? (
                <p className="text-table text-unmeasured-foreground">
                  The balance could not be read
                  {estimate.unavailableReason ? `: ${estimate.unavailableReason}` : ''}. An unknown balance
                  is neither sufficient nor insufficient, so this is not a refusal — the run-time guard
                  still applies.
                </p>
              ) : null}

              {estimate.fits === false ? (
                <p className="text-table text-danger-foreground">
                  This configuration needs more credits than the allowance has left. The run-time guard will
                  refuse it, so start is blocked until the configuration is reduced.
                </p>
              ) : null}

              {estimate.perSurface.length > 0 ? (
                <div>
                  <h3 className="text-meta font-semibold text-foreground">Per engine</h3>
                  <ul className="mt-1 divide-y divide-border">
                    {estimate.perSurface.map((row) => (
                      <li key={row.surface} className="flex items-center justify-between gap-4 py-1.5 text-table">
                        <span>{row.label}</span>
                        <span className="tabular-nums">
                          {row.metered ? (
                            formatCredits(row.credits)
                          ) : (
                            <span className="text-muted-foreground">
                              No credits — paid for by the operator&rsquo;s subscription
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <p className="text-meta text-muted-foreground">
                Credits are a Cailyx unit. They are not US dollars and are never converted or added to a
                currency figure anywhere in Cailyx (§6.3). This estimate comes from
                <span className="font-mono"> GET /aeo/budget</span> for the configuration above. It is a
                pre-flight estimate for this one run, not a project or client budget: a spend ledger,
                reservations and an approval queue are design_plan G12 and are not shown here.
              </p>
            </>
          ) : (
            <p className="text-table text-muted-foreground">
              Select at least one engine to see what this run would cost.
            </p>
          )}
        </CardContent>
      </Card>

      <RunConfigurator
        startLabel="Start full AI visibility run"
        prerequisites={[
          {
            label: 'At least one answer engine is selected',
            met: surfaces.length > 0,
            detail: surfaces.length > 0 ? surfaces.map((s) => AEO_SURFACE_LABELS[s] ?? s).join(', ') : 'Choose an engine above.',
          },
          {
            label: 'Site context has been built',
            met: context !== null,
            detail: context
              ? `Built ${context.createdAt.slice(0, 10)} from ${formatNumber(context.pagesFetched)} pages.`
              : 'The matrix is generated from the site context. Build it on the site context screen first.',
          },
          {
            label: 'Repeats are within the accepted range',
            met: runCount >= AEO_MIN_RUN_COUNT && runCount <= AEO_MAX_RUN_COUNT,
            detail: `${runCount} repeats; the API accepts ${AEO_MIN_RUN_COUNT}–${AEO_MAX_RUN_COUNT}.`,
          },
          {
            label: 'Market codes are two letters each',
            met: invalidMarkets.length === 0 && !tooManyMarkets,
            detail:
              markets.length === 0
                ? 'No market given, so the server derives one from the site context.'
                : markets.join(', '),
          },
          {
            label: 'This configuration fits the remaining allowance',
            met: estimate?.fits !== false,
            detail:
              estimate?.fits === false
                ? 'The estimate exceeds the credits left; reduce the tier, repeats or engines.'
                : estimate?.fits === null
                  ? 'The balance could not be read, so this cannot be confirmed either way. The run-time guard is the authority.'
                  : estimate
                    ? `${formatCredits(estimate.required)} needed against ${formatCredits(estimate.remaining ?? 0)} remaining.`
                    : 'Waiting for the estimate.',
          },
          {
            label: 'No AEO run is already in flight for this project',
            met: !runInFlight,
            detail: runInFlight
              ? 'An active audit already exists; open it instead of starting a second paid run.'
              : 'Nothing active.',
          },
        ]}
        parameters={[
          { key: 'engines', label: 'Engines', value: surfaces.map((s) => AEO_SURFACE_LABELS[s] ?? s).join(', ') },
          { key: 'tier', label: 'Matrix tier', value: AEO_MATRIX_TIERS.find((t) => t.tier === tier)?.label ?? tier },
          { key: 'repeats', label: 'Repeats per prompt', value: String(runCount) },
          { key: 'markets', label: 'Markets', value: markets.length > 0 ? markets.join(', ') : 'Derived from site context' },
        ]}
        scope={
          <p>
            The run builds (or reuses) the site context, generates the prompt matrix, then measures{' '}
            {prompts === null || surfaces.length === 0
              ? 'the selected configuration'
              : `${formatNumber(prompts)} prompts × ${formatNumber(surfaces.length)} engines × ${formatNumber(marketCount)} markets × ${formatNumber(runCount)} repeats = ${formatNumber(prompts * surfaces.length * marketCount * runCount)} answer calls`}{' '}
            against {project.domain}, runs the stance pass over the answers, and stores a verdict. It
            continues server-side whether or not this page stays open.
          </p>
        }
        estimate={runEstimate}
        runInFlight={runInFlight}
        onStart={async () => {
          const started = await runFullAeoAudit(projectId, {
            surfaces,
            tier,
            runCount,
            markets: markets.length > 0 ? markets : undefined,
          });
          // §10.3: save the id before navigating — the run is not tied to this page.
          router.push(`/projects/${projectId}/research/ai/runs/${started.auditId}`);
        }}
        onReconcile={() => router.push(`/projects/${projectId}/research/ai`)}
        reconcileHref={`/projects/${projectId}/research/ai`}
      />

      {/* ── The other half of "start or draft": no spend at all. ─────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Save the configuration without starting it</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-table text-muted-foreground">
            This creates the audit row with the configuration above and measures nothing. It costs no
            credits and no requests: the run only happens if someone opens it and resumes it explicitly.
          </p>
          {draftError ? <ErrorState error={draftError} layout="inline" /> : null}
          <Button
            variant="outline"
            onClick={() => void handleDraft()}
            disabled={draftInFlight || draftOutcomeUnknown || runInFlight || surfaces.length === 0}
            aria-busy={draftInFlight}
          >
            {draftInFlight ? 'Saving draft…' : 'Save as draft (no spend)'}
          </Button>
          {draftOutcomeUnknown ? (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-table text-warning-foreground">
              <p>
                The draft request did not come back. The audit row may have been created anyway, so Cailyx
                will not create a second one from here.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${projectId}/research/ai`}>Check the run list</Link>
              </Button>
            </div>
          ) : (
            <p className="text-meta text-muted-foreground">
              {surfaces.length === 0
                ? 'Select at least one engine first.'
                : 'Resuming a draft is a separate, explicit action on the run it creates.'}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 text-meta text-muted-foreground">
        <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Nothing on this page starts a run on load. The estimate is a read; the two actions above are the
          only things that can spend anything, and each names what it will do before it does it.
        </p>
      </div>
    </div>
  );
}
