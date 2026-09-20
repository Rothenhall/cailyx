'use client';

/**
 * P12 — Website: health, Google visibility, and visitors together (§7.1).
 *
 * Replaces the former three-way split ("Website health" / "Search
 * performance" / "Traffic & acquisition") with one screen: Overview, Pages,
 * Google search, Visitors. `/research/search` and `/research/traffic` now
 * redirect here (§20.3's migration convention) — see their page.tsx files.
 *
 * Every tab reads stored data only — `getWebsiteOverview`/`getWebsitePages`
 * never trigger a Google call or a new crawl (§7.6). The one live path,
 * `syncWebsiteGoogleData`, only runs from the explicit "Sync Google data"
 * action, never from a tab switch or page load.
 *
 * §7.1: "Check history" and "Technical details" are staff panels *inside*
 * this screen — deliberately not first-level navigation entries. §7.4's
 * no-fabrication limitation travels with the payload rather than being
 * restated by each tab, so the two extracts can never be presented as a
 * per-visit link.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { formatNumber } from '@/lib/format';
import { toApiError } from '@/components/patterns/ErrorState';
import { Timestamp } from '@/components/patterns/Timestamp';
import { listTechnicalAudits, type AuditRunSummary } from '@/services/research';
import {
  getWebsiteOverview,
  getWebsitePages,
  syncWebsiteGoogleData,
  type FactScope,
  type HealthState,
  type JoinedPageFacts,
  type WebsiteOverview,
} from '@/services/website';

const HEALTH_TONE: Record<HealthState, StatusTone> = {
  healthy: 'success',
  'needs-attention': 'warning',
  inaccessible: 'danger',
  unknown: 'unmeasured',
};

const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: 'Healthy',
  'needs-attention': 'Needs attention',
  inaccessible: 'Inaccessible',
  unknown: 'Not yet checked',
};

const SEVERITY_TONE: Record<string, StatusTone> = { high: 'danger', medium: 'warning', low: 'info' };

function windowLabel(w: { startDate: string; endDate: string; timezoneNote: string } | null): string {
  if (!w) return 'no data yet';
  return `${w.startDate} – ${w.endDate} (${w.timezoneNote})`;
}

/**
 * §7.3/§7.4: state the scope an extract actually covers, and say so when it
 * hit its own row limit rather than presenting a short extract as a total.
 */
function scopeSummary(scope: FactScope | null): string {
  if (!scope) return 'scope not recorded for this extract';
  const parts: string[] = [];
  parts.push(scope.countries.length ? scope.countries.join(', ') : 'all locations in the extract');
  parts.push(scope.devices.length ? scope.devices.join(', ') : 'all devices in the extract');
  if (!scope.complete) parts.push('row limit reached, so more rows may exist than are shown');
  return parts.join(' · ');
}

export default function WebsitePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab') ?? 'overview';

  const [overview, setOverview] = useState<WebsiteOverview | null>(null);
  const [pages, setPages] = useState<JoinedPageFacts[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, pg] = await Promise.all([getWebsiteOverview(projectId), getWebsitePages(projectId)]);
      setOverview(ov);
      setPages(pg);
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const setTab = (next: string) => {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set('tab', next);
    router.replace(`?${qs.toString()}`);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncWebsiteGoogleData(projectId);
      await load();
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={[{ label: 'Research & audits' }, { label: 'Website' }]}
        title="Website"
        context="See how your website is performing, what brings people to it, and what to improve next."
        primaryAction={{ label: syncing ? 'Syncing Google data…' : 'Sync Google data', onClick: handleSync, disabled: syncing }}
      />

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load Website</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {overview && <SourceAvailabilityStrip projectId={projectId} overview={overview} />}
      {overview && <WindowAlignmentNote overview={overview} />}
      <PageAnalysisLink projectId={projectId} />
      {overview && <StaffPanels projectId={projectId} />}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="pages">Pages</TabsTrigger>
          <TabsTrigger value="search">Google search</TabsTrigger>
          <TabsTrigger value="visitors">Visitors</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-6">
          {loading && <Skeleton className="h-64 w-full" />}
          {!loading && overview && <OverviewTab projectId={projectId} overview={overview} />}
        </TabsContent>

        <TabsContent value="pages">
          {loading && <Skeleton className="h-64 w-full" />}
          {!loading && pages && <PagesTable projectId={projectId} pages={pages} />}
        </TabsContent>

        <TabsContent value="search">
          {loading && <Skeleton className="h-64 w-full" />}
          {!loading && pages && overview && <SearchTab projectId={projectId} pages={pages} overview={overview} />}
        </TabsContent>

        <TabsContent value="visitors">
          {loading && <Skeleton className="h-64 w-full" />}
          {!loading && pages && overview && <VisitorsTab projectId={projectId} pages={pages} overview={overview} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SourceAvailabilityStrip({ projectId, overview }: { projectId: string; overview: WebsiteOverview }) {
  const a = overview.sourceAvailability;
  const searchConsoleOk = a.searchConsole.connected && !a.searchConsole.expired;
  const analyticsOk = a.analytics.connected && !a.analytics.expired;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
        <Badge variant={a.technicalCheck.available ? 'default' : 'outline'}>{a.technicalCheck.label}</Badge>
        <Badge variant={searchConsoleOk ? 'default' : 'outline'}>{a.searchConsole.label}</Badge>
        {!searchConsoleOk && (
          <Link className="underline" href={`/projects/${projectId}/connections/google/search-console`}>
            Connect
          </Link>
        )}
        <Badge variant={analyticsOk ? 'default' : 'outline'}>{a.analytics.label}</Badge>
        {!analyticsOk && (
          <Link className="underline" href={`/projects/${projectId}/connections/google/analytics`}>
            Connect
          </Link>
        )}
      </div>
      {/* §7.6: plain English about what connecting each missing source adds —
          and, on expiry, that the last authorized snapshot is still what is
          being shown. */}
      {overview.connectGuidance.map((line) => (
        <p key={line} className="text-meta text-muted-foreground">{line}</p>
      ))}
    </div>
  );
}

/**
 * §7.4: GSC counts in Pacific time, GA in the property timezone. When the two
 * periods cannot be aligned exactly this is disclosed and the comparison falls
 * back to whole-window scope — the dates are never relabeled as equal.
 */
function WindowAlignmentNote({ overview }: { overview: WebsiteOverview }) {
  const w = overview.windows;
  return (
    <p className="text-meta text-muted-foreground">
      <span className="font-medium text-foreground">{w.aligned ? 'Matching windows. ' : 'Windows differ. '}</span>
      {w.note}
    </p>
  );
}

/**
 * §7.1: Check history and Technical details are staff panels rendered inside
 * this screen. They are deliberately not entries in the project navigation.
 */
/**
 * R33 (§7.2): Page Analysis is part of the Website experience now. It is
 * reachable from here — and from each page's detail — rather than from a
 * second, duplicate entry in the Content group.
 */
function PageAnalysisLink({ projectId }: { projectId: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <Link className="text-meta underline" href={`/projects/${projectId}/research/website/page-analysis`}>
        Page analysis — analyze a live URL and see its run history
      </Link>
    </div>
  );
}

function StaffPanels({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<AuditRunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || runs) return;
    listTechnicalAudits(projectId)
      .then((r) => setRuns(r.audits ?? []))
      .catch(() => setFailed(true));
  }, [open, runs, projectId]);

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-meta font-medium"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>Staff: check history &amp; technical details</span>
        <span className="text-muted-foreground">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t px-3 py-3">
          <p className="text-meta text-muted-foreground">
            Every website check that has run for this project. Each opens the technical run detail.
          </p>
          {failed && <p className="text-meta text-muted-foreground">Could not load check history.</p>}
          {!failed && runs === null && <Skeleton className="h-10 w-full" />}
          {!failed && runs?.length === 0 && (
            <p className="text-meta text-muted-foreground">No website check has run yet.</p>
          )}
          {runs?.map((run) => (
            <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
              <span className="text-meta">
                {run.createdAt ? <Timestamp value={run.createdAt} /> : run.status}
                {run.targetUrl ? ` · ${run.targetUrl}` : ''}
                {typeof run.score === 'number' ? ` · score ${run.score}` : ''}
              </span>
              <Link className="text-meta underline" href={`/projects/${projectId}/research/website/runs/${run.id}`}>
                Technical details
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ projectId, overview }: { projectId: string; overview: WebsiteOverview }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-meta text-muted-foreground">Website health</CardTitle></CardHeader>
          <CardContent>
            <StatusPill label={HEALTH_LABEL[overview.health.state]} tone={HEALTH_TONE[overview.health.state]} />
            <p className="mt-2 text-meta text-muted-foreground">{overview.health.issueCount} unresolved issue{overview.health.issueCount === 1 ? '' : 's'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-meta text-muted-foreground">Google clicks / impressions</CardTitle></CardHeader>
          <CardContent>
            {overview.google.clicks == null ? (
              <p className="text-meta text-muted-foreground">
                Not measured —{' '}
                <Link className="underline" href={`/projects/${projectId}/connections/google/search-console`}>
                  connect Google Search
                </Link>
              </p>
            ) : (
              <>
                <p className="text-2xl font-semibold">{formatNumber(overview.google.clicks)} <span className="text-meta text-muted-foreground">/ {formatNumber(overview.google.impressions ?? 0)}</span></p>
                <p className="text-meta text-muted-foreground">{windowLabel(overview.google.clicksWindow)}</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-meta text-muted-foreground">Visitor sessions</CardTitle></CardHeader>
          <CardContent>
            {overview.google.sessions == null ? (
              <p className="text-meta text-muted-foreground">
                Not measured —{' '}
                <Link className="underline" href={`/projects/${projectId}/connections/google/analytics`}>
                  connect Google Analytics
                </Link>
              </p>
            ) : (
              <>
                <p className="text-2xl font-semibold">{formatNumber(overview.google.sessions)}</p>
                <p className="text-meta text-muted-foreground">{windowLabel(overview.google.sessionsWindow)}</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-meta text-muted-foreground">Average position</CardTitle></CardHeader>
          <CardContent>
            {overview.google.position == null ? (
              <p className="text-meta text-muted-foreground">Not measured</p>
            ) : (
              <>
                <p className="text-2xl font-semibold">{overview.google.position.toFixed(1)}</p>
                <p className="text-meta text-muted-foreground">weighted by impressions</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* §7.1 item 2: the two measures carry their own, explicitly stated
          windows — they are different units and are never merged into one
          figure. */}
      <p className="text-meta text-muted-foreground">
        Google clicks and impressions are Search Console figures; visitor sessions are Analytics figures. They count
        different things and are never added together.
      </p>
      <p className="text-meta text-muted-foreground">{overview.joinLimitation.statement}</p>

      <Card>
        <CardHeader><CardTitle>Insights</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {overview.insights.length === 0 && <p className="text-meta text-muted-foreground">No insights yet — connect Google and sync data to generate them.</p>}
          {overview.insights.map((ins, i) => (
            <div key={`${ins.ruleId}-${i}`} className="rounded-md border p-3">
              <div className="flex items-center gap-2">
                <StatusPill label={ins.severity} tone={SEVERITY_TONE[ins.severity] ?? 'neutral'} />
                <span className="font-medium">{ins.message}</span>
              </div>
              <p className="mt-1 text-meta text-muted-foreground">{ins.limitations}</p>
              <p className="mt-1 text-meta">Next: {ins.actionTarget}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Important pages</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="text-left text-meta text-muted-foreground">
                <th className="pb-2">Page</th>
                <th className="pb-2">Health</th>
                <th className="pb-2">Google clicks</th>
                <th className="pb-2">Organic landing sessions</th>
                <th className="pb-2">Next action</th>
              </tr>
            </thead>
            <tbody>
              {overview.importantPages.map((p) => (
                <tr key={p.pageIdentityId} className="border-t">
                  <td className="py-2">
                    <Link className="underline" href={`/projects/${projectId}/research/website/pages/${p.pageIdentityId}`}>
                      {p.title ?? p.canonicalUrl}
                    </Link>
                    <span className="block text-meta text-muted-foreground">{p.canonicalUrl}</span>
                  </td>
                  <td className="py-2"><StatusPill label={HEALTH_LABEL[p.health]} tone={HEALTH_TONE[p.health]} /></td>
                  <td className="py-2">{p.clicks == null ? 'Not measured' : formatNumber(p.clicks)}</td>
                  <td className="py-2">{p.organicSessions == null ? 'Not measured' : formatNumber(p.organicSessions)}</td>
                  <td className="py-2 text-meta text-muted-foreground">{p.nextAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function PagesTable({ projectId, pages }: { projectId: string; pages: JoinedPageFacts[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto pt-6">
        <table className="w-full text-body">
          <thead>
            <tr className="text-left text-meta text-muted-foreground">
              <th className="pb-2">Page</th>
              <th className="pb-2">Health</th>
              <th className="pb-2">Google clicks</th>
              <th className="pb-2">Organic landing sessions</th>
              <th className="pb-2">Scope</th>
              <th className="pb-2">Next action</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.pageIdentityId} className="border-t">
                <td className="py-2">
                  <Link className="underline" href={`/projects/${projectId}/research/website/pages/${p.pageIdentityId}`}>
                    {p.title ?? p.canonicalUrl}
                  </Link>
                </td>
                <td className="py-2"><StatusPill label={HEALTH_LABEL[p.health]} tone={HEALTH_TONE[p.health]} /></td>
                <td className="py-2">{p.search.available ? formatNumber(p.search.clicks) : 'Not measured'}</td>
                <td className="py-2">{p.visitors.available ? formatNumber(p.visitors.sessions) : 'Not measured'}</td>
                <td className="py-2 text-meta text-muted-foreground">{scopeSummary(p.search.scope)}</td>
                <td className="py-2 text-meta text-muted-foreground">{p.nextAction}</td>
              </tr>
            ))}
            {pages.length === 0 && (
              <tr><td colSpan={6} className="py-6 text-center text-meta text-muted-foreground">No pages yet — run a technical check or sync Google data.</td></tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SearchTab({ projectId, pages, overview }: { projectId: string; pages: JoinedPageFacts[]; overview: WebsiteOverview }) {
  const withSearch = pages.filter((p) => p.search.available);
  if (withSearch.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-meta text-muted-foreground">
          Search Console is not connected, or no data has been synced yet. No query or click figures are shown rather than
          showing zero.
        </p>
        <p className="text-meta text-muted-foreground">{overview.sourceAvailability.searchConsole.addsWhat}</p>
        <Link className="text-meta underline" href={`/projects/${projectId}/connections/google/search-console`}>
          Connect Search Console
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-meta text-muted-foreground">
        &ldquo;{overview.joinLimitation.querySideLabel}&rdquo; — {overview.joinLimitation.statement}
      </p>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <table className="w-full text-body">
            <thead>
              <tr className="text-left text-meta text-muted-foreground">
                <th className="pb-2">Page</th>
                <th className="pb-2">Clicks</th>
                <th className="pb-2">Impressions</th>
                <th className="pb-2">CTR</th>
                <th className="pb-2">Avg. position</th>
                <th className="pb-2">Dates &amp; clock</th>
                <th className="pb-2">Location / device scope</th>
              </tr>
            </thead>
            <tbody>
              {withSearch.map((p) => (
                <tr key={p.pageIdentityId} className="border-t">
                  <td className="py-2">
                    <Link className="underline" href={`/projects/${projectId}/research/website/pages/${p.pageIdentityId}`}>
                      {p.title ?? p.canonicalUrl}
                    </Link>
                  </td>
                  <td className="py-2">{formatNumber(p.search.clicks)}</td>
                  <td className="py-2">{formatNumber(p.search.impressions)}</td>
                  <td className="py-2">{(p.search.ctr * 100).toFixed(1)}%</td>
                  <td className="py-2">{p.search.position.toFixed(1)}</td>
                  <td className="py-2 text-meta text-muted-foreground">{windowLabel(p.search.window)}</td>
                  <td className="py-2 text-meta text-muted-foreground">{scopeSummary(p.search.scope)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function VisitorsTab({ projectId, pages, overview }: { projectId: string; pages: JoinedPageFacts[]; overview: WebsiteOverview }) {
  const withVisitors = pages.filter((p) => p.visitors.available);
  if (withVisitors.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-meta text-muted-foreground">
          Google Analytics is not connected, or no landing-session data has been synced yet. Visitor figures are absent
          rather than zero.
        </p>
        <p className="text-meta text-muted-foreground">{overview.sourceAvailability.analytics.addsWhat}</p>
        <Link className="text-meta underline" href={`/projects/${projectId}/connections/google/analytics`}>
          Connect Google Analytics
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-meta text-muted-foreground">
        &ldquo;{overview.joinLimitation.sessionSideLabel}&rdquo; — {overview.joinLimitation.statement}
      </p>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <table className="w-full text-body">
            <thead>
              <tr className="text-left text-meta text-muted-foreground">
                <th className="pb-2">Landing page</th>
                <th className="pb-2">Landing sessions</th>
                <th className="pb-2">Users</th>
                <th className="pb-2">Engaged sessions</th>
                <th className="pb-2">Top source / channel</th>
                <th className="pb-2">Dates &amp; clock</th>
              </tr>
            </thead>
            <tbody>
              {withVisitors.map((p) => (
                <tr key={p.pageIdentityId} className="border-t">
                  <td className="py-2">
                    <Link className="underline" href={`/projects/${projectId}/research/website/pages/${p.pageIdentityId}`}>
                      {p.title ?? p.canonicalUrl}
                    </Link>
                  </td>
                  <td className="py-2">{formatNumber(p.visitors.sessions)}</td>
                  <td className="py-2">{formatNumber(p.visitors.totalUsers)}</td>
                  <td className="py-2">
                    {formatNumber(p.visitors.engagedSessions)}
                    {p.visitors.engagementRate != null && (
                      <span className="ml-1 text-meta text-muted-foreground">({(p.visitors.engagementRate * 100).toFixed(0)}%)</span>
                    )}
                  </td>
                  <td className="py-2">{p.visitors.bySource[0]?.source ?? '—'}</td>
                  <td className="py-2 text-meta text-muted-foreground">{windowLabel(p.visitors.window)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
