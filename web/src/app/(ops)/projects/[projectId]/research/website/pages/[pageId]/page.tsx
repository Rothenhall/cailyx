'use client';

/**
 * P12 — Website page detail (§7.2).
 *
 * Summary / Search / Visitors / Content / Changes, all read from
 * `GET /projects/:id/website/pages/:pageId` — a storage-only read that never
 * calls Google or re-crawls (§7.6).
 *
 * Two rules the screen must not soften:
 *  - Search and Visitors are **related aggregate evidence**, not a per-visit
 *    link. Search Console cannot attach an organic query to an individual
 *    Analytics session, so no per-query session or conversion figure appears
 *    here, and the limitation is stated on both tabs and again on Summary.
 *  - "Changes" lists observations with dates. A change followed by a traffic
 *    change is correlational; the wording is fixed at "results improved after
 *    this change; other factors may also have contributed", and `causal` is
 *    typed `false` server-side.
 *
 * Page Analysis now lives on the Content tab (R33). The full capability — run
 * history and source URLs — is here; the duplicate Content navigation
 * destination redirects to this screen's home.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber } from '@/lib/format';
import { toApiError } from '@/components/patterns/ErrorState';
import {
  getWebsitePageDetail,
  startWebsitePageRefresh,
  type FactScope,
  type HealthState,
  type PageAnalysisRow,
  type WebsitePageChange,
  type WebsitePageDetail,
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

const CHANGE_LABEL: Record<WebsitePageChange['kind'], string> = {
  'technical-check': 'Website check',
  'technical-fix': 'Observed fix',
  'content-analysis': 'Content analysis',
  'content-revision': 'Content revision',
  'refresh-shipped': 'Refresh shipped',
};

/** §7.4: state the observed scope rather than implying coverage that was not measured. */
function scopeLabel(scope: FactScope | null, complete: boolean | undefined): string {
  const parts: string[] = [];
  if (scope) {
    parts.push(scope.countries.length ? scope.countries.join(', ') : 'all locations in the extract');
    parts.push(scope.devices.length ? scope.devices.join(', ') : 'all devices in the extract');
  }
  if (complete === false) {
    parts.push('this extract hit its own row limit, so more rows may exist than are shown — it is not a total');
  }
  return parts.length ? parts.join(' · ') : 'Scope not recorded for this extract.';
}

export default function WebsitePageDetailScreen() {
  const params = useParams<{ projectId: string; pageId: string }>();
  const { projectId, pageId } = params;

  const [detail, setDetail] = useState<WebsitePageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await getWebsitePageDetail(projectId, pageId));
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, pageId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * §7.2: "Update this page" starts/opens a refresh workflow and returns to
   * the same page context. The POST is idempotent, and this component does not
   * navigate away — it reloads the detail in place, so the reader stays on the
   * page they were reading.
   */
  const handleUpdate = async () => {
    setStarting(true);
    setNotice(null);
    try {
      const result = await startWebsitePageRefresh(projectId, pageId);
      setNotice(
        result.created
          ? `Added this page to the refresh queue (status: ${result.refresh.status}). The refresh workflow opens at Content → Refreshes.`
          : `This page already has an open refresh (status: ${result.refresh.status}). The refresh workflow opens at Content → Refreshes.`,
      );
      await load();
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setStarting(false);
    }
  };

  const facts = detail?.facts ?? null;
  const mostImportantIssue = facts?.health === 'inaccessible'
    ? 'This page could not be opened in our latest website check.'
    : facts && facts.issueCount > 0
      ? `${facts.issueCount} open issue${facts.issueCount === 1 ? '' : 's'} from the latest website check.`
      : facts && facts.health === 'unknown'
        ? 'No website check has covered this page yet.'
        : 'No open issues found in the latest check.';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Research & audits' },
          { label: 'Website', href: `/projects/${projectId}/research/website` },
          { label: 'Page' },
        ]}
        title={facts?.title ?? detail?.identity.canonicalUrl ?? 'Page'}
        context={detail?.identity.canonicalUrl}
        status={facts ? <StatusPill label={HEALTH_LABEL[facts.health]} tone={HEALTH_TONE[facts.health]} /> : undefined}
        primaryAction={{
          label: starting ? 'Starting refresh…' : 'Update this page',
          onClick: handleUpdate,
          disabled: starting,
        }}
      />

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load this page</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert>
          <AlertTitle>Refresh workflow</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{notice}</span>
            {detail?.linkedRefresh && (
              <Link className="underline" href={`/projects/${projectId}/content/refreshes`}>
                Open the refresh workflow
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      {loading && <Skeleton className="h-64 w-full" />}

      {!loading && detail && (
        <Tabs defaultValue="summary">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
            <TabsTrigger value="visitors">Visitors</TabsTrigger>
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="changes">Changes</TabsTrigger>
          </TabsList>

          {/* ── Summary ─────────────────────────────────────────────────── */}
          <TabsContent value="summary">
            <Card>
              <CardContent className="flex flex-col gap-3 pt-6">
                <p><span className="text-muted-foreground">Title:</span> {facts?.title ?? 'Not recorded'}</p>
                <p><span className="text-muted-foreground">Canonical address:</span> {detail.identity.canonicalUrl}</p>
                <p><span className="text-muted-foreground">Current health:</span> {facts ? HEALTH_LABEL[facts.health] : 'Not yet checked'}</p>
                <p><span className="text-muted-foreground">Most important issue:</span> {mostImportantIssue}</p>
                <p className="text-meta text-muted-foreground">
                  Known source URLs: {detail.identity.sourceUrls.length ? detail.identity.sourceUrls.join(', ') : detail.identity.canonicalUrl}
                </p>
                <p className="text-meta text-muted-foreground">{detail.joinLimitation.statement}</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Search ──────────────────────────────────────────────────── */}
          <TabsContent value="search">
            <Card>
              <CardContent className="pt-6">
                {!facts?.search.available ? (
                  <p className="text-meta text-muted-foreground">
                    Search Console has no data for this page, or no Google Search account is connected. No query or click
                    figures are shown rather than showing zero.
                  </p>
                ) : (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                      <div><p className="text-meta text-muted-foreground">Clicks</p><p className="text-xl font-semibold">{formatNumber(facts.search.clicks)}</p></div>
                      <div><p className="text-meta text-muted-foreground">Impressions</p><p className="text-xl font-semibold">{formatNumber(facts.search.impressions)}</p></div>
                      <div><p className="text-meta text-muted-foreground">Average CTR</p><p className="text-xl font-semibold">{(facts.search.ctr * 100).toFixed(1)}%</p></div>
                      <div><p className="text-meta text-muted-foreground">Average position</p><p className="text-xl font-semibold">{facts.search.position.toFixed(1)}</p></div>
                    </div>
                    <div className="text-meta text-muted-foreground">
                      <p>Dates: {facts.search.window?.startDate}–{facts.search.window?.endDate} ({facts.search.window?.timezoneNote})</p>
                      <p>Location / device scope: {scopeLabel(facts.search.scope, facts.search.scope?.complete)}</p>
                    </div>
                    <div>
                      <p className="mb-1 font-medium">{detail.joinLimitation.querySideLabel}</p>
                      <p className="mb-2 text-meta text-muted-foreground">{detail.joinLimitation.statement}</p>
                      <table className="w-full text-body">
                        <thead><tr className="text-left text-meta text-muted-foreground"><th className="pb-1">Query</th><th className="pb-1">Clicks</th><th className="pb-1">Impressions</th><th className="pb-1">Avg. position</th></tr></thead>
                        <tbody>
                          {facts.search.topQueries.map((q) => (
                            <tr key={q.query} className="border-t"><td className="py-1">{q.query}</td><td className="py-1">{formatNumber(q.clicks)}</td><td className="py-1">{formatNumber(q.impressions)}</td><td className="py-1">{q.position.toFixed(1)}</td></tr>
                          ))}
                          {facts.search.topQueries.length === 0 && (
                            <tr><td colSpan={4} className="py-3 text-meta text-muted-foreground">No query rows for this page in the current extract.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Visitors ────────────────────────────────────────────────── */}
          <TabsContent value="visitors">
            <Card>
              <CardContent className="pt-6">
                {!facts?.visitors.available ? (
                  <p className="text-meta text-muted-foreground">
                    Google Analytics has no landing-session data for this page, or no Analytics account is connected. Visitor
                    figures are absent rather than zero.
                  </p>
                ) : (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                      <div><p className="text-meta text-muted-foreground">Landing sessions</p><p className="text-xl font-semibold">{formatNumber(facts.visitors.sessions)}</p></div>
                      <div><p className="text-meta text-muted-foreground">Users</p><p className="text-xl font-semibold">{formatNumber(facts.visitors.totalUsers)}</p></div>
                      <div><p className="text-meta text-muted-foreground">Engaged sessions</p><p className="text-xl font-semibold">{formatNumber(facts.visitors.engagedSessions)}</p></div>
                      <div><p className="text-meta text-muted-foreground">Engagement rate</p><p className="text-xl font-semibold">{facts.visitors.engagementRate == null ? 'Not measured' : `${(facts.visitors.engagementRate * 100).toFixed(1)}%`}</p></div>
                    </div>
                    <div className="text-meta text-muted-foreground">
                      <p>Dates: {facts.visitors.window?.startDate}–{facts.visitors.window?.endDate} ({facts.visitors.window?.timezoneNote})</p>
                      {facts.visitors.scope?.complete === false && (
                        <p>This extract hit its own row limit, so more rows may exist than are shown — it is not a total.</p>
                      )}
                    </div>
                    <div>
                      <p className="mb-1 font-medium">{detail.joinLimitation.sessionSideLabel}, by source / channel</p>
                      <p className="mb-2 text-meta text-muted-foreground">{detail.joinLimitation.statement}</p>
                      <table className="w-full text-body">
                        <thead><tr className="text-left text-meta text-muted-foreground"><th className="pb-1">Source / channel</th><th className="pb-1">Sessions</th></tr></thead>
                        <tbody>
                          {facts.visitors.bySource.map((s) => (
                            <tr key={s.source} className="border-t"><td className="py-1">{s.source}</td><td className="py-1">{formatNumber(s.sessions)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Content — where Page Analysis now lives (R33) ────────────── */}
          <TabsContent value="content">
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader><CardTitle>Refresh recommendation</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <StatusPill
                    label={detail.refreshRecommendation.recommended ? 'Refresh recommended' : 'No refresh indicated'}
                    tone={detail.refreshRecommendation.recommended ? 'warning' : 'neutral'}
                  />
                  <p className="text-meta">
                    {detail.refreshRecommendation.reason ?? 'Not enough evidence to recommend either way.'}
                  </p>
                  {Object.keys(detail.refreshRecommendation.evidence).length > 0 && (
                    <p className="text-meta text-muted-foreground">
                      Based on: {Object.entries(detail.refreshRecommendation.evidence).map(([k, v]) => `${k} ${String(v)}`).join(', ')}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={handleUpdate} disabled={starting}>
                      {starting ? 'Starting refresh…' : 'Update this page'}
                    </Button>
                    {detail.linkedRefresh && (
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/projects/${projectId}/content/refreshes`}>
                          Open refresh ({detail.linkedRefresh.status})
                        </Link>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Page analysis</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {detail.content.length === 0 && (
                    <p className="text-meta text-muted-foreground">No content analysis run for this page yet.</p>
                  )}
                  {detail.content.map((c: PageAnalysisRow) => (
                    <div key={c.id} className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">Structure score: {c.structureScore}/100</span>
                        <Timestamp value={c.fetchedAt ?? c.createdAt} />
                      </div>
                      <p className="text-meta text-muted-foreground">
                        BLUF {c.blufScore}/30 · Question H2 {c.questionH2Score}/25 · Format {c.formatScore}/25 · Claims {c.claimsScore}/20 · {c.status}
                        {c.wordCount ? ` · ${formatNumber(c.wordCount)} words` : ''}
                      </p>
                      <p className="text-meta text-muted-foreground">Source URL: {c.url}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Linked Cailyx content</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {detail.linkedContent.length === 0 && (
                    <p className="text-meta text-muted-foreground">
                      No Cailyx content is published to this address yet.
                    </p>
                  )}
                  {detail.linkedContent.map((c) => (
                    <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                      <span className="font-medium">{c.title}</span>
                      <span className="text-meta text-muted-foreground">{c.assetType} · {c.status}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── Changes ─────────────────────────────────────────────────── */}
          <TabsContent value="changes">
            <Card>
              <CardContent className="flex flex-col gap-3 pt-6">
                <p className="text-meta text-muted-foreground">
                  Observed fixes and content revisions with dates. Where a change is followed by a change in traffic, the two
                  are shown side by side and nothing here claims the change caused it — &ldquo;results improved after this
                  change; other factors may also have contributed.&rdquo;
                </p>
                {detail.changes.length === 0 && (
                  <p className="text-meta text-muted-foreground">No dated changes have been observed for this page yet.</p>
                )}
                {detail.changes.map((c) => (
                  <div key={c.sourceId + c.date} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill label={CHANGE_LABEL[c.kind]} tone="neutral" />
                      <Timestamp value={c.date} />
                    </div>
                    <p className="mt-1">{c.description}</p>
                    <p className="text-meta text-muted-foreground">Source: {c.sourceId}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
