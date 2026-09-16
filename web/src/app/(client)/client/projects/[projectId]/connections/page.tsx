'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ExternalLink, Plug, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  authorizePortalGoogle,
  disconnectPortalGoogle,
  getPortalGoogleImpact,
  getPortalGoogleResources,
  getPortalGoogleStatus,
  listPortalGoogleConnections,
  PORTAL_GOOGLE_SERVICE_LABEL,
  setPortalGoogleResource,
  testPortalGoogleRead,
  type PortalGoogleConnection,
  type PortalGoogleImpact,
  type PortalGoogleResources,
  type PortalGoogleService,
  type PortalGoogleSummary,
} from '@/services/portal-access';
import {
  getPortalChecklist,
  updatePortalOnboardingRequest,
  type PortalChecklist,
} from '@/services/portal-profile';

/**
 * CP05 — Connections.
 *
 * design_plan.md §4.5: *"Own-service consent, property/site mapping, access
 * requests, reconnect/disconnect."* This is the client-scoped Google surface
 * (G02) — the operator equivalent is PJ03/PJ04, and this page is deliberately
 * *not* a copy of it:
 *
 *  1. **Three separate facts, three separate rows.** §3.5 and the §4
 *     connections family: authorization, mapped resource and last tested read
 *     are shown independently, because a green authorization badge says nothing
 *     about which property is read, and a mapped property says nothing about
 *     whether the read works.
 *  2. **Client self-connection only.** The client authorizes **their own**
 *     Google account; the backend binds the resulting connection to the caller
 *     and never accepts an owner from the request. Where a colleague's grant
 *     serves this project, the page says so and marks the mapping read-only —
 *     it does not offer a control that would 403.
 *  3. **Disconnecting shows the impact first.** The known impact is read before
 *     the confirmation and again after the disconnect, so the client sees what
 *     actually went dark rather than a bare "done".
 *
 * The read that proves a mapping works is explicit (a button, never a page
 * load), and a failed read is reported as a failure — never as zeros.
 */
export default function ClientConnectionsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<PortalGoogleConnection[] | null>(null);
  const [checklist, setChecklist] = useState<PortalChecklist | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const [pickerFor, setPickerFor] = useState<PortalGoogleService | null>(null);
  const [picker, setPicker] = useState<PortalGoogleResources | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Partial<Record<PortalGoogleService, PortalGoogleSummary>>
  >({});
  const [testErrors, setTestErrors] = useState<Partial<Record<PortalGoogleService, string>>>({});
  const [disconnecting, setDisconnecting] = useState<PortalGoogleService | null>(null);
  const [disconnectImpact, setDisconnectImpact] = useState<PortalGoogleImpact | null>(null);
  const [disconnectOutcome, setDisconnectOutcome] = useState<PortalGoogleImpact | null>(null);
  const [requestBusy, setRequestBusy] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, statusResult, connectionsResult, checklistResult] = await Promise.allSettled([
          listPortalProjectSummaries({ signal }),
          getPortalGoogleStatus(projectId, { signal }),
          listPortalGoogleConnections(projectId, { signal }),
          getPortalChecklist(projectId, { signal }),
        ]);

        if (projects.status === 'rejected') throw projects.reason;
        setProject(projects.value.find((entry) => entry.id === projectId) ?? null);
        if (statusResult.status === 'fulfilled') setConfigured(statusResult.value.configured);
        if (connectionsResult.status === 'fulfilled') setConnections(connectionsResult.value);
        if (checklistResult.status === 'fulfilled') setChecklist(checklistResult.value);
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

  async function openPicker(service: PortalGoogleService) {
    setPickerFor(service);
    setPicker(null);
    setPickerError(null);
    try {
      setPicker(await getPortalGoogleResources(projectId, service));
    } catch (caught) {
      setPickerError(
        caught instanceof Error ? caught.message : 'The list of sites and properties could not be read.',
      );
    }
  }

  async function onConnect(service: PortalGoogleService) {
    setBusy(`connect:${service}`);
    setActionError(null);
    try {
      const { url } = await authorizePortalGoogle(projectId, service);
      // Full navigation rather than a popup: the consent screen must be
      // unmistakably Google's own, and a popup can be blocked silently.
      window.location.href = url;
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The authorization could not be started.',
      );
      setBusy(null);
    }
  }

  async function onChoose(service: PortalGoogleService, resourceId: string, resourceLabel?: string) {
    setBusy(`map:${service}`);
    setActionError(null);
    try {
      await setPortalGoogleResource(projectId, { service, resourceId, resourceLabel });
      setPickerFor(null);
      setPicker(null);
      await load();
    } catch (caught) {
      setPickerError(
        caught instanceof Error ? caught.message : 'That property could not be mapped.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function onTest(service: PortalGoogleService) {
    setBusy(`test:${service}`);
    setTestErrors((current) => ({ ...current, [service]: undefined }));
    try {
      const summary = await testPortalGoogleRead(projectId, service, 28);
      setTestResults((current) => ({ ...current, [service]: summary }));
    } catch (caught) {
      setTestErrors((current) => ({
        ...current,
        [service]: caught instanceof Error ? caught.message : 'The read failed with no detail returned.',
      }));
    } finally {
      setBusy(null);
    }
  }

  async function prepareDisconnect(service: PortalGoogleService) {
    setBusy(`impact:${service}`);
    setActionError(null);
    const connection = connections?.find((entry) => entry.service === service);
    try {
      if (connection?.connectionId) {
        setDisconnectImpact(await getPortalGoogleImpact(projectId, connection.connectionId));
      } else {
        setDisconnectImpact(null);
      }
      setDisconnecting(service);
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'The impact of disconnecting could not be read, so nothing was disconnected.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function onDisconnect(service: PortalGoogleService) {
    setBusy(`disconnect:${service}`);
    try {
      const impact = await disconnectPortalGoogle(projectId, service);
      setDisconnectOutcome(impact);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'The connection could not be revoked.');
    } finally {
      setBusy(null);
      setDisconnecting(null);
      setDisconnectImpact(null);
    }
  }

  async function markRequest(requestId: string, status: 'in-progress' | 'done') {
    setRequestBusy(requestId);
    setActionError(null);
    try {
      await updatePortalOnboardingRequest(projectId, requestId, { status });
      await load();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'That request could not be updated.',
      );
    } finally {
      setRequestBusy(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Connections" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (connections === null || configured === null || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  const accessRequests = (checklist?.blocking ?? []).filter((entry) =>
    `${entry.kind} ${entry.title}`.toLowerCase().match(/access|connect|google|property|analytics|console/) !== null,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Connections' },
        ]}
        title="Connections"
        context="Each service is authorized, mapped and verified separately."
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {!configured ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Google connections are not available on this deployment</AlertTitle>
          <AlertDescription>
            The server has no Google OAuth credentials configured, so no
            connection can be made or reconnected from here. This is a
            deployment setting, not something a button on this page can fix —
            your delivery team can connect it on their side.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>You authorize your own Google account</AlertTitle>
          <AlertDescription>
            Connecting grants Cailyx read access through the account you are
            signed into Google with. Choosing which site or property we read is a
            separate step afterwards, and you can disconnect at any time.
          </AlertDescription>
        </Alert>
      )}

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {disconnectOutcome ? (
        <Alert role="status">
          <AlertTitle>Disconnected</AlertTitle>
          <AlertDescription>
            {disconnectOutcome.affectedProjects.length === 0
              ? 'No project of yours was reading through this connection.'
              : `${disconnectOutcome.affectedProjects.length} mapping${disconnectOutcome.affectedProjects.length === 1 ? '' : 's'} can no longer be read: ${disconnectOutcome.affectedProjects
                  .map((entry) => entry.resourceLabel ?? entry.resourceId)
                  .join(', ')}.`}{' '}
            {disconnectOutcome.affectedDelegates.length > 0
              ? `${disconnectOutcome.affectedDelegates.length} delegated access grant${
                  disconnectOutcome.affectedDelegates.length === 1 ? '' : 's'
                } were revoked at the same time.`
              : 'No delegated access was affected.'}{' '}
            Collected data is not deleted.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-4">
        {(Object.keys(PORTAL_GOOGLE_SERVICE_LABEL) as PortalGoogleService[]).map((service) => {
          const connection = connections.find((entry) => entry.service === service);
          const isOwner = connection?.access === 'owner';
          const isDelegated = connection?.access === 'delegated';
          const mapped = Boolean(connection?.mappedResourceId);
          const summary = testResults[service];
          const testError = testErrors[service];

          return (
            <Card key={service}>
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div className="space-y-1">
                  <CardTitle className="text-table font-medium">
                    {PORTAL_GOOGLE_SERVICE_LABEL[service]}
                  </CardTitle>
                  <p className="text-meta text-muted-foreground">
                    {service === 'search-console'
                      ? 'Which searches show your site, and how people find it.'
                      : 'How visitors arrive and what they do on the site.'}
                  </p>
                </div>
                <StatusPill
                  label={connectionLabel(connection)}
                  tone={
                    !connection || connection.access === 'none'
                      ? 'unmeasured'
                      : connection.expired
                        ? 'warning'
                        : 'success'
                  }
                />
              </CardHeader>

              <CardContent className="space-y-4">
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                  <Fact label="Authorization">
                    {connection && connection.access !== 'none' ? (
                      <>
                        {isDelegated
                          ? 'A colleague authorized this account and shared access with you'
                          : 'You authorized this account'}
                        {connection.googleEmail ? (
                          <span className="mt-0.5 block font-mono text-meta">
                            {connection.googleEmail}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">No account connected</span>
                    )}
                  </Fact>
                  <Fact label="Chosen property or site">
                    {mapped ? (
                      <>
                        {connection?.mappedResourceLabel ?? 'A property is mapped'}
                        <span className="mt-0.5 block font-mono text-meta break-all">
                          {connection?.mappedResourceId}
                        </span>
                      </>
                    ) : (
                      // §3.5 — OAuth connected but nothing mapped is not ready.
                      <span className="text-muted-foreground">Not chosen yet</span>
                    )}
                  </Fact>
                  <Fact label="Last verified read">
                    {testError ? (
                      <span className="text-danger-foreground">Failed: {testError}</span>
                    ) : summary ? (
                      <span>
                        Read succeeded over {summary.range.days} days to{' '}
                        {formatDate(summary.range.endDate)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not tested in this session</span>
                    )}
                  </Fact>
                </dl>

                {connection?.connectedAt ? (
                  <p className="text-meta text-muted-foreground">
                    Connected <Timestamp value={connection.connectedAt} />
                    {connection.expiresAt ? (
                      <>
                        {' '}
                        · access expires <Timestamp value={connection.expiresAt} dateOnly />
                      </>
                    ) : null}
                  </p>
                ) : null}

                {connection?.expired ? (
                  <Alert variant="destructive" role="alert">
                    <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                    <AlertTitle>Access has expired</AlertTitle>
                    <AlertDescription>
                      Google access for this account needs renewing before this
                      service can be read again. Reconnecting replaces the
                      existing grant — nothing collected is deleted.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {connection?.lastError ? (
                  <Alert>
                    <AlertTitle>The last read reported a problem</AlertTitle>
                    <AlertDescription>{connection.lastError}</AlertDescription>
                  </Alert>
                ) : null}

                {isDelegated ? (
                  <p className="text-meta text-muted-foreground">
                    This connection is owned by someone else on your account, so
                    you can see the mapping but cannot change it. Ask them, or
                    connect your own account below.
                  </p>
                ) : null}

                {summary ? <SummaryReadout summary={summary} /> : null}

                <div className="flex flex-wrap items-center gap-2">
                  {isOwner ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void openPicker(service)}
                      >
                        {mapped ? 'Change property or site' : 'Choose property or site'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || !mapped}
                        onClick={() => void onTest(service)}
                      >
                        {busy === `test:${service}` ? 'Reading…' : 'Test read'}
                        <span className="sr-only">
                          , proves the mapping works and shows what came back
                        </span>
                      </Button>
                      {/* An expired grant cannot be renewed with a test read —
                          consent has to be given again. */}
                      {connection?.expired ? (
                        <Button
                          size="sm"
                          disabled={busy !== null || !configured}
                          onClick={() => void onConnect(service)}
                        >
                          <Plug aria-hidden="true" className="mr-2 h-4 w-4" />
                          {busy === `connect:${service}` ? 'Opening Google…' : 'Reconnect this account'}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void prepareDisconnect(service)}
                      >
                        {busy === `impact:${service}` ? 'Checking impact…' : 'Disconnect'}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy !== null || !configured}
                      onClick={() => void onConnect(service)}
                    >
                      <Plug aria-hidden="true" className="mr-2 h-4 w-4" />
                      {busy === `connect:${service}` ? 'Opening Google…' : 'Connect your Google account'}
                      <ExternalLink aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Access requests ────────────────────────────────────────────── */}
      <section aria-labelledby="access-requests-heading" className="space-y-3">
        <h2 id="access-requests-heading" className="text-subsection font-semibold tracking-tight">
          Access we have asked you for
        </h2>
        <Card>
          <CardContent className="space-y-3 py-4">
            {checklist === null ? (
              <p className="text-table text-muted-foreground">
                The access requests could not be read just now. Reload to try again.
              </p>
            ) : accessRequests.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="outstanding access requests"
                prerequisite="Nothing is waiting on you. When something is, it appears here with the work it is holding up."
              />
            ) : (
              <ul className="divide-y divide-border">
                {accessRequests.map((entry) => (
                  <li key={entry.requestId} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="text-table font-medium">{entry.title}</div>
                      {entry.blockedWorkLinks.length > 0 ? (
                        <p className="mt-1 text-meta text-muted-foreground">
                          Holding up:{' '}
                          {entry.blockedWorkLinks
                            .map((link) => (link.missing ? `${link.title ?? 'an item'} (no longer present)` : (link.title ?? 'an item')))
                            .join(', ')}
                        </p>
                      ) : null}
                      {entry.dueAt ? (
                        <p className="text-meta text-muted-foreground">
                          Due <Timestamp value={entry.dueAt} dateOnly />
                          {entry.overdue ? ' — overdue' : ''}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={requestBusy === entry.requestId}
                        onClick={() => void markRequest(entry.requestId, 'done')}
                      >
                        Done
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={requestBusy === entry.requestId}
                        onClick={() => void markRequest(entry.requestId, 'in-progress')}
                      >
                        Started
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-meta text-muted-foreground">
              The full checklist, including what Cailyx still owes you, is on the{' '}
              <Link
                href={`/client/projects/${projectId}/welcome`}
                className="text-primary underline underline-offset-4"
              >
                welcome screen
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </section>

      {/* ── Resource picker ────────────────────────────────────────────── */}
      <Dialog
        open={pickerFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPickerFor(null);
            setPicker(null);
            setPickerError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Choose the {pickerFor ? PORTAL_GOOGLE_SERVICE_LABEL[pickerFor] : ''} property or site
            </DialogTitle>
            <DialogDescription>
              Pick the exact identifier we should read for this project. Two
              properties can share a name, so the identifier is shown as well —
              mapping the wrong one produces plausible-looking but wrong numbers.
            </DialogDescription>
          </DialogHeader>

          {pickerError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{pickerError}</AlertDescription>
            </Alert>
          ) : null}

          {picker === null && !pickerError ? (
            <Skeleton className="h-32 rounded-lg" />
          ) : picker === null ? null : picker.options.length === 0 ? (
            <div className="space-y-2">
              <p className="text-table">
                {picker.connected
                  ? 'The connected account returned no sites or properties it can read.'
                  : 'The connected account could not be read — the grant may need reconnecting.'}
              </p>
              <p className="text-meta text-muted-foreground">
                {picker.connected
                  ? 'If the property belongs to a different Google account, connect that account from the connections screen instead.'
                  : 'Reconnect the account, then try again.'}
              </p>
            </div>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {picker.options.map((option) => (
                <li
                  key={option.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <span className="min-w-0">
                    <span className="block text-table font-medium">{option.label}</span>
                    <span className="block font-mono text-meta break-all text-muted-foreground">
                      {option.id}
                    </span>
                    {option.detail ? (
                      <span className="block text-meta text-muted-foreground">{option.detail}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    {picker.selected?.resourceId === option.id ? (
                      <StatusPill label="Currently mapped" tone="neutral" />
                    ) : null}
                    <Button
                      size="sm"
                      variant={picker.selected?.resourceId === option.id ? 'ghost' : 'default'}
                      disabled={busy !== null}
                      onClick={() =>
                        pickerFor && void onChoose(pickerFor, option.id, option.label)
                      }
                    >
                      Read this
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPickerFor(null);
                setPicker(null);
                setPickerError(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Disconnect confirmation, with the impact read first ────────── */}
      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDisconnecting(null);
            setDisconnectImpact(null);
          }
        }}
        title="Disconnect this Google service?"
        targetLabel="Service"
        target={disconnecting ? PORTAL_GOOGLE_SERVICE_LABEL[disconnecting] : ''}
        confirmLabel="Disconnect"
        destructive
        effect={
          disconnectImpact
            ? `Revokes the stored Google grant${
                disconnectImpact.affectedProjects.length > 0
                  ? ` and un-maps ${disconnectImpact.affectedProjects
                      .map((entry) => entry.resourceLabel ?? entry.resourceId)
                      .join(', ')}`
                  : ''
              }. ${
                disconnectImpact.affectedDelegates.length > 0
                  ? `${disconnectImpact.affectedDelegates.length} delegated access grant${
                      disconnectImpact.affectedDelegates.length === 1 ? '' : 's'
                    } on this connection are revoked too.`
                  : 'No delegated access is affected.'
              }`
            : 'Revokes the stored Google grant. We cannot show the affected mappings right now, so some project reports may stop receiving fresh data until it is reconnected.'
        }
        scope="Data already collected is not deleted. Reconnecting a different account does not restore this one's access."
        onConfirm={() => {
          if (disconnecting) return onDisconnect(disconnecting);
        }}
      />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-table">{children}</dd>
    </div>
  );
}

function connectionLabel(connection: PortalGoogleConnection | undefined): string {
  if (!connection || connection.access === 'none') return 'Not connected';
  if (connection.expired) return 'Access expired';
  if (connection.access === 'delegated') return 'Delegated access';
  return 'Connected';
}

/**
 * The headline of a test read.
 *
 * Both summary shapes are shown as what they are: provider numbers over a named
 * window. A read that returned no rows is stated as such, and a rate is printed
 * with `formatPercent`, never confused with a percentage-point change.
 */
function SummaryReadout({ summary }: { summary: PortalGoogleSummary }) {
  const isSearch = 'site' in summary;
  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3">
      <p className="text-meta text-muted-foreground">
        Read from {isSearch ? summary.site : summary.property} ·{' '}
        {formatDate(summary.range.startDate)} to {formatDate(summary.range.endDate)}
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-4">
        {isSearch ? (
          <>
            <Readout label="Clicks" value={formatNumber(summary.totals.clicks)} />
            <Readout label="Impressions" value={formatNumber(summary.totals.impressions)} />
            <Readout label="Click-through rate" value={formatPercent(summary.totals.ctr * 100)} />
            <Readout label="Average position" value={summary.totals.position.toFixed(1)} />
          </>
        ) : (
          <>
            <Readout label="Sessions" value={formatNumber(summary.totals.sessions)} />
            <Readout label="Users" value={formatNumber(summary.totals.totalUsers)} />
            <Readout label="Page views" value={formatNumber(summary.totals.screenPageViews)} />
            <Readout
              label="Engagement rate"
              value={formatPercent(summary.totals.engagementRate * 100)}
            />
          </>
        )}
      </dl>
      <p className="mt-2 text-meta text-muted-foreground">
        This is a live read from the provider, not a stored report figure.
      </p>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="text-table font-medium tabular-nums">{value}</dd>
    </div>
  );
}
