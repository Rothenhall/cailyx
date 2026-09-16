'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ExternalLink, Plug, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  beginGoogleAuthorization,
  disconnectGoogle,
  getGoogleConnections,
  getGoogleStatus,
  testGoogleRead,
  type GoogleConnection,
  type GoogleServiceStatus,
} from '@/services/integrations';

/**
 * PJ03 — Connections.
 *
 * design_plan.md §4's connections family: *"Service cards show authorization,
 * mapped resource and last tested read independently; selection dialog shows
 * exact property/site identifier; disconnect flow presents known impact; manual
 * profile URLs appear in a separate section."*
 *
 * This page implements the first and third of those, plus the §3.5 states that
 * matter most here:
 *
 *   - **"Credentials configured but runtime unverified"** → "Configured; last
 *     successful run unknown". A configured OAuth client is not a working
 *     connection, and a granted connection is not a mapped resource. The card
 *     shows all three separately so none of them can pass for another.
 *   - **The test read is explicit.** Nothing here probes Google on page load;
 *     the operator presses it, and the result is what changes the card's state.
 *
 * The resource picker (PJ04) and the disconnect-impact preview are not built
 * here — they need the client-scoped Google surface, which is `@ClientPortal()`
 * and belongs on the client connections screen. This page says so rather than
 * offering a control that would 403.
 */

const SERVICES = [
  {
    service: 'search-console' as const,
    name: 'Google Search Console',
    purpose: 'Search clicks, impressions, position and sitemap state.',
  },
  {
    service: 'analytics' as const,
    name: 'Google Analytics',
    purpose: 'Traffic, channels and landing-page engagement.',
  },
];

export default function ConnectionsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [status, setStatus] = useState<GoogleServiceStatus | null>(null);
  const [connections, setConnections] = useState<GoogleConnection[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busyService, setBusyService] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [disconnecting, setDisconnecting] = useState<'search-console' | 'analytics' | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [statusResult, connectionsResult] = await Promise.all([
          getGoogleStatus({ signal }),
          getGoogleConnections({ signal }),
        ]);
        setStatus(statusResult);
        setConnections(connectionsResult.connections);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onConnect(service: 'search-console' | 'analytics') {
    setBusyService(service);
    setActionError(null);
    try {
      // The route answers `{ url }` — see the adapter's note on why the field
      // name matters here.
      const { url } = await beginGoogleAuthorization({
        service,
        projectId,
        returnTo: `/projects/${projectId}/connections`,
      });
      // Full navigation, not a popup: the OAuth consent screen must be
      // unmistakably Google's own, and a popup can be blocked silently.
      window.location.href = url;
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'The authorization could not be started.',
      );
    } finally {
      setBusyService(null);
    }
  }

  async function onTest(service: 'search-console' | 'analytics') {
    setBusyService(service);
    setActionError(null);
    try {
      await testGoogleRead({ service, projectId, days: 28 });
      setTestResult((current) => ({
        ...current,
        [service]: `Read succeeded on ${new Date().toLocaleString()}.`,
      }));
    } catch (caught) {
      setTestResult((current) => ({
        ...current,
        [service]:
          caught instanceof Error
            ? `Read failed: ${caught.message}`
            : 'Read failed with no detail returned.',
      }));
    } finally {
      setBusyService(null);
    }
  }

  async function onDisconnect(service: 'search-console' | 'analytics') {
    setBusyService(service);
    setActionError(null);
    try {
      await disconnectGoogle(service);
      await load();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The connection could not be revoked.',
      );
    } finally {
      setBusyService(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Connections" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!status || !connections) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        context="Each service is authorized, mapped and verified separately."
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {/*
        The three-way distinction §3.5 requires. Configuring an OAuth client
        says nothing about whether an account has granted access, and granting
        access says nothing about which property is mapped.
      */}
      {!status.configured ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Google integration is not configured on this server</AlertTitle>
          <AlertDescription>
            The OAuth client credentials are missing, so no connection can be
            made from this page. This is a deployment setting, not something a
            button here can fix.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>OAuth client configured</AlertTitle>
          <AlertDescription>
            The server holds Google credentials. That alone does not mean any
            account has granted access — check each service below.
          </AlertDescription>
        </Alert>
      )}

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-4">
        {SERVICES.map(({ service, name, purpose }) => {
          const connection = connections.find((entry) => entry.service === service);
          const granted = Boolean(connection?.connectedAt || connection?.hasGrant);
          const busy = busyService === service;

          return (
            <Card key={service}>
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div className="space-y-1">
                  <CardTitle className="text-table font-medium">{name}</CardTitle>
                  <p className="text-meta text-muted-foreground">{purpose}</p>
                </div>
                <StatusPill
                  label={granted ? 'Authorized' : 'Not authorized'}
                  tone={granted ? 'success' : 'unmeasured'}
                />
              </CardHeader>

              <CardContent className="space-y-4">
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                  <Fact label="Authorization">
                    {granted ? (
                      <span>
                        Granted
                        {connection?.accountEmail ? ` as ${connection.accountEmail}` : ''}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">No account connected</span>
                    )}
                  </Fact>
                  <Fact label="Mapped resource">
                    {/*
                      The backend exposes the mapping through the client-scoped
                      picker; this operator page does not receive it. Saying
                      "not shown here" is honest; showing "mapped" would not be.
                    */}
                    <span className="text-muted-foreground">
                      Chosen from the resource picker
                    </span>
                  </Fact>
                  <Fact label="Last verified read">
                    {testResult[service] ? (
                      <span>{testResult[service]}</span>
                    ) : (
                      // §3.5 — a never-probed connection is unverified, not ready.
                      <span className="text-muted-foreground">
                        Not tested in this session
                      </span>
                    )}
                  </Fact>
                </dl>

                {connection?.connectedAt ? (
                  <p className="text-meta text-muted-foreground">
                    Connected <Timestamp value={connection.connectedAt} />
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  {granted ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void onTest(service)}
                      >
                        Test read
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setDisconnecting(service)}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy || !status.configured}
                      onClick={() => void onConnect(service)}
                    >
                      <Plug aria-hidden="true" className="mr-2 h-4 w-4" />
                      {busy ? 'Opening Google…' : 'Connect Google account'}
                      <ExternalLink aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        title="Disconnect this Google service?"
        targetLabel="Service"
        target={
          disconnecting === 'search-console' ? 'Google Search Console' : 'Google Analytics'
        }
        confirmLabel="Disconnect"
        destructive
        effect="The stored grant is revoked and forgotten. Any project mapped to a resource from this account stops receiving data from it, and the mapped resource will need choosing again."
        scope="Existing collected data is not deleted. New runs that depend on this connection will fail until it is reconnected."
        onConfirm={() => {
          if (disconnecting) return onDisconnect(disconnecting);
        }}
        onConfirmed={() => setDisconnecting(null)}
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
