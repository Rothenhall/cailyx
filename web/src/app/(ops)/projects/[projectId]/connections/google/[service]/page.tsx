'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  GOOGLE_SERVICE_LABEL,
  getGoogleAuthorizationUrl,
  getGoogleConfigured,
  getGoogleResourcesView,
  listGoogleConnectionViews,
  putGoogleResource,
  readGoogleSummary,
  type GoogleConnectionView,
  type GoogleResourcesView,
} from '@/services/integrations';
import { getProject } from '@/services/projects';
import { ApiError } from '@/lib/api';

/**
 * PJ04 — Google resource picker.
 *
 * design_plan.md §4.3: *"Connected Google identity, properties/sites, current
 * mapping, test-read result, reconnect"*, support "E; mapping ownership/impact
 * G02".
 *
 * §4's connections family gives the rule this page is built around: *"Service
 * cards show authorization, mapped resource and last tested read
 * **independently**."* Those are three separate facts and this screen keeps
 * them three separate blocks, in that order, because each one can be true while
 * the next is false:
 *
 *  1. **Identity** — which Google account granted access, when, and whether the
 *     stored grant is still usable. A grant that has expired is shown as
 *     connected-but-expired, which is §3.5's "configured but runtime
 *     unverified", never a green tick.
 *  2. **Resource** — the exact site or property, by identifier, that reads for
 *     this project will use. Two GSC properties can share a display label, so
 *     the identifier is the primary text here and the label is secondary.
 *  3. **Test read** — a real read through the mapped resource. Nothing probes
 *     Google on page load: the operator asks, and the answer is what changes the
 *     state from "mapped" to "verified working".
 *
 * The mapping change goes through `ConfirmDialog`, because re-pointing the
 * mapping changes which site every Search Console read on this project uses —
 * the §4 requirement is that the selection dialog shows the exact identifier and
 * the flow states its impact, not that it asks politely.
 */
const SERVICES = ['search-console', 'analytics'] as const;
type GoogleService = (typeof SERVICES)[number];

export default function GoogleResourcePickerPage() {
  const params = useParams<{ projectId: string; service: string }>();
  const projectId = params.projectId;
  const rawService = params.service;
  const service: GoogleService | null = SERVICES.includes(rawService as GoogleService)
    ? (rawService as GoogleService)
    : null;

  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<GoogleConnectionView | null>(null);
  const [view, setView] = useState<GoogleResourcesView | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<string>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapNotice, setMapNotice] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [testError, setTestError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [testedAt, setTestedAt] = useState<string | null>(null);

  const [authorizing, setAuthorizing] = useState(false);
  const [authorizeError, setAuthorizeError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!service) return;
      const [configResult, connectionsResult, viewResult] = await Promise.all([
        getGoogleConfigured({ signal }),
        listGoogleConnectionViews({ signal }),
        getGoogleResourcesView({ service, projectId }, { signal }),
      ]);
      setConfigured(configResult.configured);
      setConnection(connectionsResult.find((row) => row.service === service) ?? null);
      setView(viewResult);
      setSelected(viewResult.selected?.resourceId ?? '');
    },
    [projectId, service],
  );

  useEffect(() => {
    if (!service) {
      setLoading(false);
      return;
    }
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
  }, [load, service]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const project = await getProject(projectId, { signal: controller.signal });
        setProjectName(project.name);
      } catch {
        /* name is context only */
      }
    })();
    return () => controller.abort();
  }, [projectId]);

  // The consent flow runs in a popup: the backend's callback page is written to
  // postMessage its result to the opener and close itself. Post-hydration only.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { source?: string; status?: string } | null;
      if (!data || data.source !== 'cailyx-google-oauth') return;
      stopPolling();
      void load().catch(() => undefined);
    }
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      stopPolling();
    };
  }, [load]);

  function stopPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function onAuthorize() {
    if (!service || authorizing) return;
    setAuthorizeError(null);
    setAuthorizing(true);
    try {
      const { url } = await getGoogleAuthorizationUrl({ service, projectId });
      // A popup, so the consent screen can close itself and hand the result
      // back without the operator losing this page.
      const popup = window.open(url, 'cailyx-google-oauth', 'width=520,height=640');
      if (!popup) {
        // Blocked popup. Full navigation is the fallback; the operator will
        // need to come back and re-check, and the page says so.
        window.location.href = url;
        return;
      }
      popupRef.current = popup;

      // Bounded reconciliation: ten checks over forty seconds, stopped the
      // moment the popup closes. Deliberately not an open-ended poll — the
      // backend limit is 100 requests/minute/IP and an office shares one IP.
      let ticks = 0;
      stopPolling();
      pollRef.current = setInterval(() => {
        ticks += 1;
        if (popupRef.current?.closed || ticks > 10) {
          stopPolling();
          void load().catch(() => undefined);
          return;
        }
        void load().catch(() => undefined);
      }, 4000);
    } catch (caught) {
      setAuthorizeError(toApiError(caught).message);
    } finally {
      setAuthorizing(false);
    }
  }

  async function onTestRead() {
    if (!service || testing) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await readGoogleSummary({ service, projectId, days: 28 });
      setTestResult(result);
      setTestedAt(new Date().toISOString());
    } catch (caught) {
      setTestError(toApiError(caught));
    } finally {
      setTesting(false);
    }
  }

  if (!service) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader breadcrumbs={[{ label: 'Connections', href: `/projects/${projectId}/connections` }]} title="Google resource" />
        <ErrorState
          error={
            new ApiError({
              kind: 'not-found',
              status: 404,
              message: `"${rawService}" is not a Google service this app can map.`,
            })
          }
          notFoundReason="prerequisite"
          restrictedAction={undefined}
        />
        <p className="text-table text-muted-foreground">
          The only mappable services are{' '}
          {SERVICES.map((value) => GOOGLE_SERVICE_LABEL[value]).join(' and ')}.{' '}
          <Link href={`/projects/${projectId}/connections`} className="underline underline-offset-4">
            Back to connections
          </Link>
        </p>
      </div>
    );
  }

  const label = GOOGLE_SERVICE_LABEL[service];
  const mapped = view?.selected ?? null;
  const choices = view?.options ?? [];
  const selectionChanged = Boolean(selected) && selected !== (mapped?.resourceId ?? '');
  const selectedChoice = choices.find((choice) => choice.id === selected) ?? null;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: projectName ?? 'Project', href: `/projects/${projectId}` },
          { label: 'Connections', href: `/projects/${projectId}/connections` },
          { label },
        ]}
        title={label}
        context={projectName ? `Resource mapping for ${projectName}` : undefined}
        status={
          connection ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill
                tone={connection.connected ? (connection.expired ? 'warning' : 'success') : 'unmeasured'}
                label={
                  connection.connected
                    ? connection.expired
                      ? 'Grant expired'
                      : 'Connected'
                    : 'Not connected'
                }
              />
              {mapped ? (
                <StatusPill tone="info" label="Resource mapped" />
              ) : (
                <StatusPill tone="warning" label="No resource mapped" />
              )}
            </span>
          ) : undefined
        }
      />

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            setLoading(true);
            void load()
              .catch((caught) => setError(toApiError(caught)))
              .finally(() => setLoading(false));
          }}
          providerName="Google"
        />
      ) : null}

      {configured === false ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Google OAuth is not configured on the server</AlertTitle>
          <AlertDescription>
            The API reports no OAuth client id or secret. No authorization can be started until that
            server configuration exists — this is a deployment state, not something this screen can
            fix.
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      ) : (
        <>
          {/* 1. Authorization — which account, and whether the grant still works. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Connected Google identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {connection?.connected ? (
                <dl className="grid gap-1 text-table">
                  <Row label="Account">
                    {connection.googleEmail ?? (
                      <span className="text-muted-foreground">
                        The grant exists but the account address was not recorded.
                      </span>
                    )}
                  </Row>
                  <Row label="Granted">
                    {connection.connectedAt ? (
                      <Timestamp value={connection.connectedAt} />
                    ) : (
                      notMeasuredLabel()
                    )}
                  </Row>
                  <Row label="Expires">
                    {connection.expiresAt ? (
                      <Timestamp value={connection.expiresAt} />
                    ) : (
                      notMeasuredLabel()
                    )}
                  </Row>
                  <Row label="Scope">
                    <span className="font-mono text-meta">
                      {connection.scope || 'No scope recorded'}
                    </span>
                  </Row>
                  {connection.lastError ? (
                    <Row label="Last error">
                      <span className="text-danger-foreground">{connection.lastError}</span>
                    </Row>
                  ) : null}
                </dl>
              ) : (
                <p className="text-table">
                  No Google account has granted access for {label} under your operator login. Reads
                  for this project will not work until one does.
                </p>
              )}

              {authorizeError ? (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{authorizeError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={connection?.connected ? 'outline' : 'default'}
                  onClick={() => void onAuthorize()}
                  disabled={authorizing || configured === false}
                >
                  {authorizing
                    ? 'Opening Google…'
                    : connection?.connected
                      ? 'Reconnect Google account'
                      : 'Connect Google account'}
                </Button>
                {connection?.connected ? (
                  <Button type="button" variant="ghost" onClick={() => void load()}>
                    Re-check connection
                  </Button>
                ) : null}
              </div>

              <p className="text-meta text-muted-foreground">
                Reconnecting replaces the stored grant for this operator and service. A grant is
                per-operator, not per-project (mapping ownership is G02), so reconnecting here also
                affects other projects that rely on your grant.
              </p>
            </CardContent>
          </Card>

          {/* 2. Resource — the exact identifier reads will use. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                {service === 'search-console' ? 'Sites' : 'Properties'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-table">
                <p className="text-muted-foreground">Currently mapped</p>
                {mapped ? (
                  <p className="space-y-0.5">
                    <span className="block font-mono text-body">{mapped.resourceId}</span>
                    <span className="block text-meta text-muted-foreground">
                      {mapped.resourceLabel
                        ? `Displayed as “${mapped.resourceLabel}”`
                        : 'No display label was recorded for this mapping.'}
                    </span>
                  </p>
                ) : (
                  <p className="text-warning-foreground">
                    No site or property is mapped, so every read for this project fails with a
                    &ldquo;not mapped yet&rdquo; error rather than returning nothing.
                  </p>
                )}
              </div>

              {!view?.connected ? (
                <EmptyState
                  variant="source-unmapped"
                  sourceName={label}
                  action={{
                    label: connection?.connected ? 'Re-check connection' : 'Connect Google',
                    onClick: () => (connection?.connected ? void load() : void onAuthorize()),
                  }}
                  layout="inline"
                >
                  <p>
                    The site/property list could not be read, so the choices below are unavailable —
                    this list is empty because it is unreadable, not because the account can read
                    nothing.
                  </p>
                </EmptyState>
              ) : choices.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject={`readable ${service === 'search-console' ? 'Search Console sites' : 'Analytics properties'}`}
                  prerequisite={`a Google account with access to at least one ${service === 'search-console' ? 'site' : 'property'}`}
                  layout="inline"
                >
                  <p>
                    The connected account returned no resources it can read. That is a real answer,
                    not a failure: the grant may belong to an account that has no access to this
                    client&apos;s properties.
                  </p>
                </EmptyState>
              ) : (
                <>
                  <fieldset className="space-y-3">
                    <legend className="text-table font-medium">
                      Choose the{' '}
                      {service === 'search-console' ? 'site' : 'property'} this project reads from
                    </legend>
                    <RadioGroup
                      value={selected}
                      onValueChange={setSelected}
                      className="space-y-2"
                    >
                      {choices.map((choice) => (
                        <div key={choice.id} className="flex items-start gap-3">
                          <RadioGroupItem
                            value={choice.id}
                            id={`resource-${choice.id}`}
                            className="mt-1"
                          />
                          <Label
                            htmlFor={`resource-${choice.id}`}
                            className="cursor-pointer space-y-0.5 font-normal"
                          >
                            {/* The identifier is the primary text: two properties
                                can share a label, so the label alone cannot
                                tell them apart. */}
                            <span className="block font-mono text-table">{choice.id}</span>
                            <span className="block text-meta text-muted-foreground">
                              {choice.label}
                              {choice.detail ? ` · ${choice.detail}` : ''}
                            </span>
                          </Label>
                        </div>
                      ))}
                    </RadioGroup>
                  </fieldset>

                  {mapError ? (
                    <Alert variant="destructive" role="alert">
                      <AlertDescription>{mapError}</AlertDescription>
                    </Alert>
                  ) : null}
                  {mapNotice ? (
                    <Alert>
                      <AlertDescription>{mapNotice}</AlertDescription>
                    </Alert>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      disabled={!selectionChanged || mapping}
                    >
                      {mapping ? 'Saving mapping…' : 'Map this selection'}
                    </Button>
                    {!selectionChanged && selected ? (
                      <span className="text-meta text-muted-foreground">
                        This is already the mapped selection.
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* 3. Test read — a real read, asked for explicitly. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Test-read result</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-table text-muted-foreground">
                This reads the last 28 days through the mapped resource. It is the only thing on this
                page that proves the connection works — a mapping on its own is a configured
                intent, not a verified read.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void onTestRead()}
                  disabled={testing || !mapped}
                >
                  {testing ? 'Reading…' : 'Run test read'}
                </Button>
                {!mapped ? (
                  <span className="text-meta text-muted-foreground">
                    Map a {service === 'search-console' ? 'site' : 'property'} first — the read
                    addresses the mapped resource.
                  </span>
                ) : null}
                {testedAt ? (
                  <span className="text-meta text-muted-foreground">
                    Last run <Timestamp value={testedAt} />
                  </span>
                ) : null}
              </div>

              {testError ? (
                <ErrorState
                  error={testError}
                  layout="inline"
                  providerName={label}
                  notFoundReason="prerequisite"
                  onRetry={() => void onTestRead()}
                />
              ) : null}

              {testResult ? (
                <TestReadSummary service={service} result={testResult} />
              ) : null}
            </CardContent>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Map this ${service === 'search-console' ? 'site' : 'property'}`}
        confirmLabel="Change the mapping"
        targetLabel="New resource identifier"
        target={selectedChoice?.id ?? selected}
        effect={
          <>
            Every {label} read for this project — reports, audits and monitoring — will address the
            resource above from the next run onward.
          </>
        }
        scope={
          <>
            Past runs keep the resource they ran against; this changes what future reads use.
            Re-pointing a mapping does not move or delete any already-collected data.
            {mapped ? (
              <>
                {' '}
                The resource currently mapped ({mapped.resourceId}) is replaced.
              </>
            ) : null}
          </>
        }
        onConfirm={async () => {
          setMapping(true);
          setMapError(null);
          try {
            await putGoogleResource({
              service,
              projectId,
              resourceId: selectedChoice?.id ?? selected,
              resourceLabel: selectedChoice?.label ?? null,
            });
          } catch (caught) {
            const apiError = toApiError(caught);
            setMapError(
              apiError.kind === 'conflict'
                ? apiError.message
                : 'The mapping was not changed. The previous resource is still in effect.',
            );
            throw caught;
          } finally {
            setMapping(false);
          }
        }}
        onConfirmed={() => {
          setConfirmOpen(false);
          setMapNotice('Mapping saved. Run a test read to confirm the new resource answers.');
          // A confirmed save can reshape the list, so reload rather than assume.
          void load().catch(() => undefined);
        }}
        onReload={() => void load()}
      />
    </div>
  );
}

/**
 * The test read's answer, rendered as the handful of numbers the endpoint
 * actually returns. Every value is measured — an absent one is not drawn at
 * all rather than drawn as zero.
 */
function TestReadSummary({
  service,
  result,
}: {
  service: GoogleService;
  result: Record<string, unknown>;
}) {
  const range = result.range as { startDate?: string; endDate?: string; days?: number } | undefined;
  const totals = (result.totals ?? {}) as Record<string, unknown>;

  const rows =
    service === 'search-console'
      ? [
          ['Clicks', totals.clicks],
          ['Impressions', totals.impressions],
          ['CTR', totals.ctr],
          ['Average position', totals.position],
        ]
      : [
          ['Sessions', totals.sessions],
          ['Users', totals.totalUsers],
          ['Page views', totals.screenPageViews],
          ['Engagement rate', totals.engagementRate],
          ['Average session duration', totals.averageSessionDuration],
        ];

  const resource = service === 'search-console' ? result.site : result.property;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill tone="success" label="Read succeeded" />
        {typeof resource === 'string' ? (
          <span className="font-mono text-meta">{resource}</span>
        ) : null}
      </div>

      {range ? (
        <p className="text-meta text-muted-foreground">
          Window: {range.startDate} to {range.endDate}
          {typeof range.days === 'number' ? ` (${formatNumber(range.days)} days)` : ''}
        </p>
      ) : null}

      <dl className="grid gap-1 text-table sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={String(label)} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{String(label)}</dt>
            <dd className="font-medium tabular-nums">
              {typeof value === 'number' ? formatNumber(value) : notMeasuredLabel()}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-meta text-muted-foreground">
        These are raw totals for the window, not a performance statement. design_plan §6.4 forbids
        reading significance into a single window with no comparable baseline.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
