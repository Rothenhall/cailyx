'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import {
  Ban,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { notMeasuredLabel } from '@/lib/format';
import {
  listCapabilities,
  type CapabilityView,
  type CapabilityRoster,
  type CapabilityState,
} from '@/services/admin';
import {
  getGoogleConnections,
  getGoogleStatus,
  type GoogleConnection,
  type GoogleServiceStatus,
} from '@/services/integrations';

/**
 * OP15 — Service connections (readiness).
 *
 * design_plan.md §4.2: *"Provider readiness, last error, dependency
 * explanations, Google account state."* The administration family adds
 * *"separate saved configuration from observed runtime health"*, and §3.5's
 * governing sentence is *"No enabled button merely because an env key exists."*
 *
 * ## Why this screen is shaped the way it is
 *
 * The endpoint reports **four independent facts** — `configured`, `verified`,
 * `authorized`, `resourceMapped` — and this screen renders all four, in four
 * labelled rows, for every capability. A single tick is not available from the
 * data and must not be synthesised from it:
 *
 *   - `configured: true, verified: false` renders as §3.5's exact sentence,
 *     **"Configured; last successful run unknown"** — never as ready.
 *   - "OAuth connected, resource unmapped" is its own state with its own
 *     action, not an error and not a pass.
 *   - `mockMode` is surfaced on the card *and* in a roster-level banner,
 *     because a fixture result must never be read as a measurement.
 *
 * Controls are rendered from the server's own `allowedActions`, which is by
 * contract empty unless the state is `ready`. There is therefore no code path
 * here that can enable an action from an environment variable alone — this
 * screen could not draw an active button for an unverified provider even if
 * someone wanted it to.
 *
 * Nothing on this page probes a provider. Every observation shown is one the
 * backend already recorded; `checkedAt` says when it was read.
 */

const FILTER_DEFAULTS = {
  q: '',
  category: FILTER_ALL,
  state: FILTER_ALL,
  attention: false,
};

const CATEGORY_LABELS: Record<string, string> = {
  'aeo-engine': 'AI answer engines',
  'ai-surface': 'AI surfaces',
  'serp-data': 'Search data',
  analytics: 'Analytics',
  'site-health': 'Site health',
  social: 'Social',
  llm: 'Language models',
  content: 'Content',
  email: 'Email',
  billing: 'Billing',
  infrastructure: 'Infrastructure',
  mode: 'Operating mode',
};

/** Every state the backend can return, with the tone §3.5 asks for. */
const STATE_TONE: Record<CapabilityState, StatusTone> = {
  ready: 'success',
  // Not a failure and not a pass: configured, never observed working.
  unverified: 'unmeasured',
  unconfigured: 'unmeasured',
  blocked: 'warning',
  // Fixtures: neither healthy nor broken, and never a measurement.
  mock: 'info',
  degraded: 'danger',
  unauthorized: 'unmeasured',
  unmapped: 'warning',
};

const STATE_LABEL: Record<CapabilityState, string> = {
  ready: 'Ready',
  unverified: 'Unverified',
  unconfigured: 'Not configured',
  blocked: 'Blocked',
  mock: 'Fixture mode',
  degraded: 'Degraded',
  unauthorized: 'Not authorized for you',
  unmapped: 'Resource unmapped',
};

/** Blocked-by codes are operator-only, so the wording can be plain. */
const BLOCKED_BY_LABEL: Record<string, string> = {
  'credential-missing': 'The credential is not set on this server',
  'master-switch-off': 'A cross-cutting master switch is off',
  'session-missing': 'A browser surface is enabled with no session path configured',
  'session-file-missing': 'A session path is configured but the file is not on disk',
  prerequisite: 'A capability this one depends on is not ready',
  'not-authorized': 'You are not authorized for it',
  'resource-unmapped': 'This project has no resource mapped',
  'never-verified': 'Nothing has ever actually called it',
  'last-call-failed': 'The last recorded attempt failed',
  'mock-only': 'Running against fixtures',
};

/** Text tones for a count. Colour is never the only signal — every caller
 *  pairs it with a label and a sentence. */
const TONE_TEXT: Record<StatusTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  unmeasured: 'text-unmeasured',
  neutral: 'text-foreground',
};

export default function AdminConnectionsPage() {
  // `useSearchParams` (through `useUrlState`) forces a client-side bailout
  // during prerendering, so the URL-reading part sits behind its own boundary.
  return (
    <Suspense fallback={<ConnectionsSkeleton />}>
      <ConnectionsScreen />
    </Suspense>
  );
}

function ConnectionsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function ConnectionsScreen() {
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [roster, setRoster] = useState<CapabilityRoster | null>(null);
  const [googleStatus, setGoogleStatus] = useState<GoogleServiceStatus | null>(null);
  const [googleConnections, setGoogleConnections] = useState<GoogleConnection[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const capabilities = await listCapabilities({ signal });
      setRoster(capabilities);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
      return;
    }
    // The Google account state is a separate read on a separate module; a
    // failure there must not blank the readiness roster, so it is loaded
    // after and allowed to fail quietly into its own "unknown" presentation.
    try {
      const [status, connections] = await Promise.all([
        getGoogleStatus({ signal }),
        getGoogleConnections({ signal }),
      ]);
      setGoogleStatus(status);
      setGoogleConnections(connections.connections);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setGoogleStatus(null);
      setGoogleConnections(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const categoryOptions = useMemo(() => {
    if (!roster) return [];
    const seen = new Set(roster.capabilities.map((c) => c.category));
    return [...seen].map((category) => ({
      value: category,
      label: CATEGORY_LABELS[category] ?? category,
    }));
  }, [roster]);

  const stateOptions = useMemo(() => {
    if (!roster) return [];
    const seen = new Set(roster.capabilities.map((c) => c.state));
    return [...seen].map((state) => ({
      value: state,
      label: STATE_LABEL[state as CapabilityState] ?? state,
    }));
  }, [roster]);

  const visible = useMemo(() => {
    if (!roster) return [];
    const query = filters.q.trim().toLowerCase();
    return roster.capabilities.filter((capability) => {
      if (filters.category !== FILTER_ALL && capability.category !== filters.category) return false;
      if (filters.state !== FILTER_ALL && capability.state !== filters.state) return false;
      if (filters.attention) {
        // "Needs attention" is a readiness question, not a health score: a
        // capability is worth looking at when it is not ready, or when the
        // result it produces is not a measurement.
        if (capability.state === 'ready' && !capability.mockMode) return false;
      }
      if (!query) return true;
      return [capability.label, capability.key, capability.state, capability.category]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [roster, filters]);

  const grouped = useMemo(() => {
    const byCategory = new Map<string, CapabilityView[]>();
    for (const capability of visible) {
      const list = byCategory.get(capability.category) ?? [];
      list.push(capability);
      byCategory.set(capability.category, list);
    }
    return [...byCategory.entries()].sort(([a], [b]) =>
      (CATEGORY_LABELS[a] ?? a).localeCompare(CATEGORY_LABELS[b] ?? b),
    );
  }, [visible]);

  async function onRefresh() {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }

  // §3.5 "Insufficient role": explain the restriction and the permitted path.
  // The nav filters this entry by role, but a copied link still lands here, and
  // a 403 must not be dressed up as a failed fetch.
  if (error?.kind === 'forbidden') {
    return (
      <div className="space-y-6">
        <PageHeader title="Service connections" />
        <EmptyState
          variant="insufficient-role"
          restrictedAction="read the service readiness roster"
          permittedPath="Ask an administrator to check provider readiness, or open the project's own Connections page, which reports the same facts for one project."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Service connections" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!roster) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const summary = roster.summary;
  const fixtures = roster.capabilities.filter((c) => c.mockMode);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Service connections"
        context={
          <>
            Readiness for {summary.total} provider-backed capabilit
            {summary.total === 1 ? 'y' : 'ies'}. Configuration, verification,
            authorization and resource mapping are reported separately — none of
            them stands in for another.
          </>
        }
        secondaryActions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={isRefreshing}
          >
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            {isRefreshing ? 'Refreshing…' : 'Refresh readiness'}
          </Button>
        }
      />

      {/*
        Fixture mode is disclosed at roster level as well as per card. A
        capability whose result came from fixtures is not a measurement, and
        §3.5 forbids letting one be read as one.
      */}
      {fixtures.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <FlaskConical aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>
            {fixtures.length} capabilit{fixtures.length === 1 ? 'y is' : 'ies are'} running
            against fixtures
          </AlertTitle>
          <AlertDescription>
            <p>
              Results from these providers are simulated, not measured:{' '}
              {fixtures.map((c) => c.label).join(', ')}. Nothing here is evidence
              about a real site, and production work must not be enabled from a
              fixture result.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label="Ready"
          value={summary.ready}
          tone="success"
          detail="All four facts hold, and the server will accept at least one action."
        />
        <SummaryTile
          label="Configured but unverified"
          value={(summary.byState.unverified ?? 0) + (summary.byState.unconfigured ?? 0)}
          tone="unmeasured"
          detail="A credential exists, or is missing. Neither is a working connection."
        />
        <SummaryTile
          label="Blocked or degraded"
          value={(summary.byState.blocked ?? 0) + (summary.byState.degraded ?? 0)}
          tone={(summary.byState.degraded ?? 0) > 0 ? 'danger' : 'warning'}
          detail="An unmet dependency, or a provider whose last call failed."
        />
        <SummaryTile
          label="Fixture mode"
          value={fixtures.length}
          tone={fixtures.length > 0 ? 'info' : 'neutral'}
          detail="Providers returning simulated results rather than measurements."
        />
      </div>

      {/* Google account state — §4.2 names it as part of this screen. */}
      <GoogleAccountPanel status={googleStatus} connections={googleConnections} />

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        controls={[
          {
            kind: 'select',
            key: 'category',
            label: 'Category',
            options: categoryOptions,
            allLabel: 'All categories',
          },
          {
            kind: 'select',
            key: 'state',
            label: 'Readiness',
            options: stateOptions,
            allLabel: 'All states',
          },
          { kind: 'toggle', key: 'attention', label: 'Needs attention' },
        ]}
        summary={`Showing ${visible.length} of ${roster.capabilities.length}`}
      />

      {visible.length === 0 ? (
        <EmptyState variant="no-results" onClearFilters={() => setFilters(FILTER_DEFAULTS)} />
      ) : (
        <div className="space-y-8">
          {grouped.map(([category, capabilities]) => (
            <section key={category} aria-labelledby={`category-${category}`} className="space-y-3">
              <h2 id={`category-${category}`} className="text-subsection font-semibold">
                {CATEGORY_LABELS[category] ?? category}
              </h2>
              <div className="space-y-4">
                {capabilities.map((capability) => (
                  <CapabilityCard key={capability.key} capability={capability} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A count of capabilities in one condition. Deliberately **not** a
 * `MetricTile`: that component states a measured value with its unit, window,
 * source date and evidence, and a tally of roster entries has none of those.
 * The number here is a navigation aid, and it is toned but never the only
 * signal — the label and the sentence beneath it say what it counts.
 */
function SummaryTile({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: number;
  tone: StatusTone;
  detail: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-meta text-muted-foreground">{label}</span>
          <span className={`text-subsection tabular-nums font-semibold ${TONE_TEXT[tone]}`}>
            {value}
          </span>
        </div>
        <p className="text-meta text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function CapabilityCard({ capability }: { capability: CapabilityView }) {
  const state = capability.state;
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-table font-medium">{capability.label}</CardTitle>
            <p className="font-mono text-meta text-muted-foreground">{capability.key}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {capability.mockMode ? (
              <Badge variant="outline" className="border-info/60 text-info">
                <FlaskConical aria-hidden="true" className="mr-1 h-3 w-3" />
                Fixture mode
              </Badge>
            ) : null}
            <StatusPill
              label={STATE_LABEL[state] ?? state}
              tone={STATE_TONE[state] ?? 'neutral'}
            />
          </div>
        </div>
        <p className="text-table">{capability.stateDetail}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/*
          The four facts. Rendered as four rows on every card, whether or not
          they agree — a capability that is configured and verified still shows
          its authorization and mapping rows, because the reader is comparing
          them, not reading a verdict.
        */}
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Fact label="Configured on this server">
            {capability.configured ? (
              <span className="text-foreground">Yes</span>
            ) : (
              <span className="text-muted-foreground">No</span>
            )}
          </Fact>

          <Fact label="Verified by a successful call">
            {capability.verified ? (
              capability.lastSuccessAt ? (
                <span>
                  Yes — <Timestamp value={capability.lastSuccessAt} />
                </span>
              ) : (
                <span>Yes — the recorded time was not returned</span>
              )
            ) : capability.configured ? (
              // §3.5's exact wording for "configured but runtime unverified".
              <span className="text-muted-foreground">
                Configured; last successful run unknown
              </span>
            ) : (
              <span className="text-muted-foreground">
                {notMeasuredLabel()} — nothing is configured to call
              </span>
            )}
          </Fact>

          <Fact label="Authorized for you">
            {capability.authorized ? (
              <span>Yes</span>
            ) : (
              <span className="text-muted-foreground">
                No — this capability is not authorized for your account
              </span>
            )}
          </Fact>

          <Fact label="Resource mapped to the project">
            {capability.resourceMapped === null ? (
              <span className="text-muted-foreground">
                Not applicable on this view — project resources are checked per
                project
              </span>
            ) : capability.resourceMapped ? (
              <span>Yes</span>
            ) : (
              <span className="text-warning">
                No — the account is connected but nothing is pointed at a site
                or property
              </span>
            )}
          </Fact>
        </dl>

        {capability.blockedBy ? (
          <Alert>
            <Ban aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Blocked by: {capability.blockedBy}</AlertTitle>
            <AlertDescription>
              {BLOCKED_BY_LABEL[capability.blockedBy] ?? 'No explanation was supplied.'}
              {/* `operatorGuidance` below carries the backend's own next-step
                  sentence for this capability; this line names the cause only. */}
            </AlertDescription>
          </Alert>
        ) : null}

        {capability.lastError ? (
          <Alert variant="destructive" role="alert">
            <ShieldAlert aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>
              Last provider error
              {capability.lastErrorAt ? (
                <>
                  {' '}
                  — <Timestamp value={capability.lastErrorAt} />
                </>
              ) : null}
            </AlertTitle>
            <AlertDescription>
              {/*
                The raw provider error as recorded. Rendered as text, never as
                markup (§10.5) — it is remote content.
              */}
              <span className="font-mono text-meta break-words">{capability.lastError}</span>
            </AlertDescription>
          </Alert>
        ) : null}

        {capability.operatorGuidance ? (
          <div>
            <h4 className="text-meta font-medium text-muted-foreground">Configuration</h4>
            <p className="mt-1 text-table">{capability.operatorGuidance}</p>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="text-meta font-medium text-muted-foreground">Dependencies</h4>
            {capability.prerequisites.length === 0 ? (
              <p className="mt-1 text-table text-muted-foreground">
                This capability has no prerequisites.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-table">
                {capability.prerequisites.map((prerequisite) => {
                  const unmet = capability.unmetPrerequisites.includes(prerequisite);
                  return (
                    <li key={prerequisite} className="flex items-start gap-2">
                      {unmet ? (
                        <XCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 text-danger" />
                      ) : (
                        <CheckCircle2
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 text-success"
                        />
                      )}
                      <span>
                        {prerequisite}{' '}
                        {unmet ? (
                          <span className="text-muted-foreground">— not ready</span>
                        ) : (
                          <span className="text-muted-foreground">— ready</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <h4 className="text-meta font-medium text-muted-foreground">Server configuration</h4>
            {/* Names only — a value is never returned by this endpoint. */}
            {capability.envVars.length === 0 ? (
              <p className="mt-1 text-table text-muted-foreground">
                No environment variable is involved.
              </p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {capability.envVars.map((name) => (
                  <li key={name}>
                    <Badge variant="outline" className="font-mono text-meta">
                      {name}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {capability.configDetail ? (
              <p className="mt-2 font-mono text-meta break-words text-muted-foreground">
                {capability.configDetail}
              </p>
            ) : null}
            <p className="mt-2 text-meta text-muted-foreground">
              Variable names are shown; their values are never returned.
            </p>
          </div>
        </div>

        <Separator />

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-meta font-medium text-muted-foreground">
              Actions the server will currently accept
            </h4>
            {capability.allowedActions.length === 0 ? (
              // This is the §3.5 rule made visible: no action exists to enable.
              <p className="mt-1 text-table text-muted-foreground">
                None. Actions become available only when every readiness fact
                holds — an environment variable alone never enables one.
              </p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {capability.allowedActions.map((action) => (
                  <li key={action}>
                    <Badge variant="secondary" className="font-mono text-meta">
                      {action}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="text-right text-meta text-muted-foreground">
            {capability.retryable ? (
              <p>Retrying the provider call is a sensible next step.</p>
            ) : (
              <p>Retrying is not indicated for this state.</p>
            )}
            <p className="mt-1">
              Read <Timestamp value={capability.checkedAt} />
            </p>
          </div>
        </div>

        {capability.mockMode && capability.mockDisclosure ? (
          <Alert variant="destructive" role="alert">
            <FlaskConical aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Fixture mode</AlertTitle>
            <AlertDescription>{capability.mockDisclosure}</AlertDescription>
          </Alert>
        ) : null}

        {capability.supportedProviders.length > 0 || capability.availableOutputs.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {capability.supportedProviders.length > 0 ? (
              <div>
                <h4 className="text-meta font-medium text-muted-foreground">Providers</h4>
                <p className="mt-1 text-table">{capability.supportedProviders.join(', ')}</p>
              </div>
            ) : null}
            {capability.availableOutputs.length > 0 ? (
              <div>
                <h4 className="text-meta font-medium text-muted-foreground">Produces</h4>
                <p className="mt-1 text-table">{capability.availableOutputs.join(', ')}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Google account state.
 *
 * §4's connections family: *"Service cards show authorization, mapped resource
 * and last tested read independently."* The same three-way distinction applies
 * at the organization level — the OAuth client being configured says nothing
 * about whether an account granted access, and a grant says nothing about which
 * property is mapped.
 *
 * This panel never claims a mapping. The mapping lives on the project picker
 * (PJ04), so the row says where to find it rather than showing a guess.
 */
function GoogleAccountPanel({
  status,
  connections,
}: {
  status: GoogleServiceStatus | null;
  connections: GoogleConnection[] | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-table font-medium">Google account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status === null ? (
          <p className="text-table text-muted-foreground">
            The Google integration status could not be read. This is a separate
            service from the readiness roster above; its unavailability does not
            change any capability&rsquo;s state. Not measured.
          </p>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="OAuth client on this server">
                {status.configured ? (
                  <span>Configured</span>
                ) : (
                  <span className="text-muted-foreground">
                    Not configured — no connection can be made from this
                    deployment
                  </span>
                )}
              </Fact>
              <Fact label="Account grant">
                {connections && connections.length > 0 ? (
                  <span>
                    {connections.length} service
                    {connections.length === 1 ? '' : 's'} granted
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    No account has granted access
                  </span>
                )}
              </Fact>
            </dl>

            {connections && connections.length > 0 ? (
              <ul className="space-y-2">
                {connections.map((connection) => (
                  <li
                    key={connection.service}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-table font-medium">{connection.service}</div>
                      <div className="text-meta text-muted-foreground">
                        {connection.accountEmail ?? 'Account address not recorded'}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {connection.connectedAt ? (
                        <span className="text-meta text-muted-foreground">
                          Granted <Timestamp value={connection.connectedAt} />
                        </span>
                      ) : (
                        <span className="text-meta text-muted-foreground">
                          Grant time not recorded
                        </span>
                      )}
                      <StatusPill
                        label={connection.hasGrant ? 'Refresh grant stored' : 'No refresh grant'}
                        tone={connection.hasGrant ? 'success' : 'warning'}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="text-meta text-muted-foreground">
              Which Google property or site is mapped to a project is chosen on
              that project&rsquo;s Connections page and is not shown here. An
              account grant with no mapping is not a working connection.
            </p>
          </>
        )}
      </CardContent>
    </Card>
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
