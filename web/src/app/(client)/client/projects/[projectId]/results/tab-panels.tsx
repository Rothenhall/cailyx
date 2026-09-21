'use client';

import Link from 'next/link';
import { ExternalLink, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { MetricTile } from '@/components/patterns/MetricTile';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  AiVisibilityTabData,
  CompetitorsTabData,
  CompetitorsTabDiff,
  OnlinePresenceTabData,
  OverviewSection,
  PortalResultsTab,
  PortalTabData,
  WebsiteTabData,
} from '@/services/overview';

/**
 * The four client Results tabs (§3.3), rendered from the server's client-safe
 * projections.
 *
 * Every panel here renders a payload it did not compute. `ResultsTabsService`
 * read the domain module that owns the data and narrowed it (§4.6: handles,
 * provenance vectors and provider exception text removed, storage states
 * rewritten as labels), so this file's job is presentation and nothing else —
 * it never re-queries, never re-labels a state into a different claim and
 * never fills a gap with a zero.
 *
 * Three rules that show up per panel:
 *
 *  1. **A number exists only when it was measured.** Every numeric tile passes
 *     `value={x ?? null}`, so `MetricTile` renders "Not measured yet" rather
 *     than `0` for a window nothing reported on (§3.5 "Empty is not zero").
 *  2. **A failed read degrades one tab.** The envelope is the tab: `unavailable`
 *     renders the server's safe sentence and the other three tabs are
 *     untouched (§4.5).
 *  3. **Movement is not coloured as success.** Tiles are `direction="neutral"`:
 *     these figures describe what was recorded, and §6.4 forbids inventing a
 *     significance the measurement does not have.
 */

/** §10.5: only an http(s) URL or an app-relative path may become a link target. */
function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('/')) return href;
  return /^https?:\/\//i.test(href) ? href : undefined;
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function ExternalLinkText({ href, children }: { href: string; children: React.ReactNode }) {
  const target = safeHref(href);
  if (!target) return <span>{children}</span>;
  return (
    <a
      href={target}
      className="text-primary underline underline-offset-4"
      {...(isExternal(target) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
      {isExternal(target) ? <ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3" /> : null}
    </a>
  );
}

/**
 * The envelope, rendered. `section === null` means the tab is still loading, and
 * the skeleton is shaped like the panel it replaces (§4.5).
 */
export function ResultsTabPanel({
  tab,
  section,
}: {
  tab: PortalResultsTab;
  section: OverviewSection<PortalTabData[PortalResultsTab]> | null;
}) {
  if (!section) return <TabSkeleton tab={tab} />;

  if (section.status === 'unavailable') {
    return (
      <Card>
        <CardContent className="space-y-2 py-4">
          <p className="text-table text-muted-foreground">
            {section.reason ?? 'We could not load this part of your results just now.'}
          </p>
          <p className="text-meta text-muted-foreground">
            The other tabs are unaffected — this is one area failing to load, not your account.
          </p>
        </CardContent>
      </Card>
    );
  }

  switch (tab) {
    case 'website':
      return <WebsiteTab section={section as OverviewSection<WebsiteTabData>} />;
    case 'ai':
      return <AiVisibilityTab section={section as OverviewSection<AiVisibilityTabData>} />;
    case 'presence':
      return <PresenceTab section={section as OverviewSection<OnlinePresenceTabData>} />;
    case 'competitors':
      return <CompetitorsTab section={section as OverviewSection<CompetitorsTabData>} />;
  }
}

function TabSkeleton({ tab }: { tab: PortalResultsTab }) {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-28" />
      </div>
      {tab === 'ai' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </>
      )}
    </div>
  );
}

/** A section heading that says what the tab answers, reused by every panel. */
function TabHeading({ title, context }: { title: string; context?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-table font-semibold text-foreground">{title}</h3>
      {context ? <span className="text-meta text-muted-foreground">{context}</span> : null}
    </div>
  );
}

function EmptyOrData({
  section,
  emptyCopy,
  children,
}: {
  section: OverviewSection<unknown>;
  /** Shown when the read answered with nothing yet. */
  emptyCopy: string;
  children: React.ReactNode;
}) {
  if (section.status === 'empty') {
    return (
      <Card>
        <CardContent className="py-4 text-table text-muted-foreground">
          {section.reason ?? emptyCopy}
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}

// ─── Website ─────────────────────────────────────────────────────────────────

function WebsiteTab({ section }: { section: OverviewSection<WebsiteTabData> }) {
  const data = section.data;
  if (!data) {
    return (
      <Card>
        <CardContent className="py-4 text-table text-muted-foreground">{section.reason}</CardContent>
      </Card>
    );
  }

  return (
    <EmptyOrData section={section} emptyCopy="We have not checked your website yet.">
      <div className="space-y-5">
        {/* `id="google"` is the anchor the score's Google-visibility bucket
            links to (§5.5's drilldown), so a reader lands on the block the
            bucket is about. */}
        <div id="google" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Site health"
            value={data.health.state === 'unknown' ? null : data.health.issueCount}
            unit={data.health.issueCount === 1 ? 'issue' : 'issues'}
            note={data.health.label}
            direction="neutral"
          />
          <MetricTile label="Clicks from Google" value={data.google.clicks} unit="clicks" direction="neutral" />
          <MetricTile
            label="Times you appeared in Google"
            value={data.google.impressions}
            unit="impressions"
            direction="neutral"
          />
          <MetricTile label="Sessions on your site" value={data.google.sessions} unit="sessions" direction="neutral" />
        </div>

        {data.google.position !== null ? (
          <p className="text-meta text-muted-foreground">
            Average position in Google search results: {formatNumber(data.google.position)}.
          </p>
        ) : null}

        {/* §7.4 — the two windows are stated as two windows. A reader deciding
            whether to trust a comparison needs this before the numbers. */}
        <div className="space-y-1">
          <TabHeading title="How the windows line up" />
          <p className={cn('text-meta', data.windows.aligned ? 'text-muted-foreground' : 'text-warning-foreground')}>
            {data.windows.note}
          </p>
          {data.windows.coarserComparison ? (
            <p className="text-meta text-warning-foreground">
              The comparison uses the coarser of the two windows, so the finer-grained side is not overstated.
            </p>
          ) : null}
        </div>

        {data.importantPages.length > 0 ? (
          <div className="space-y-2">
            <TabHeading title="Pages that matter" context={`${data.importantPages.length} page(s)`} />
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.importantPages.map((page) => (
                <li key={page.canonicalUrl} className="space-y-1 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-table font-medium">
                      {page.title ?? urlToPath(page.canonicalUrl)}
                    </span>
                    <span
                      className={cn(
                        'text-meta',
                        page.health === 'needs-attention' ? 'text-warning-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {page.healthLabel}
                    </span>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    {urlToPath(page.canonicalUrl)} ·{' '}
                    {page.clicks !== null ? `${formatNumber(page.clicks)} clicks` : notMeasuredLabel()} ·{' '}
                    {page.organicSessions !== null
                      ? `${formatNumber(page.organicSessions)} sessions`
                      : notMeasuredLabel()}
                  </p>
                  <p className="text-meta text-muted-foreground">{page.nextAction}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {data.insights.length > 0 ? (
          <div className="space-y-2">
            <TabHeading title="What we found" context={`${data.insights.length} finding(s)`} />
            <ul className="space-y-2">
              {data.insights.map((insight) => (
                <li key={insight.message} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    {insight.crossSource ? (
                      <span className="text-meta font-medium text-primary">Seen across sources</span>
                    ) : null}
                    <span
                      className={cn(
                        'text-meta',
                        insight.severity === 'high' ? 'text-warning-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {insight.severity} priority
                    </span>
                    {insight.sourceCount > 0 ? (
                      <span className="text-meta text-muted-foreground">
                        backed by {insight.sourceCount} source{insight.sourceCount === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-table">{insight.message}</p>
                  <p className="text-meta text-muted-foreground">{insight.actionTarget}</p>
                  {/* The owning module's own limitation text. It is not optional:
                      a finding without its limitation reads as a certainty. */}
                  <p className="text-meta text-muted-foreground">{insight.limitations}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="space-y-2">
          <TabHeading title="Where these numbers come from" />
          <ul className="space-y-1 text-meta text-muted-foreground">
            <li>
              Site check: {data.sourceAvailability.technicalCheck.label}
              {data.sourceAvailability.technicalCheck.lastCheckedAt ? (
                <>
                  {' '}
                  · last checked <Timestamp value={data.sourceAvailability.technicalCheck.lastCheckedAt} dateOnly />
                </>
              ) : null}
            </li>
            <li>
              Google Search Console: {data.sourceAvailability.searchConsole.label}
              {data.sourceAvailability.searchConsole.expired ? ' (the connection has expired)' : ''}
            </li>
            <li>
              Google Analytics: {data.sourceAvailability.analytics.label}
              {data.sourceAvailability.analytics.expired ? ' (the connection has expired)' : ''}
            </li>
          </ul>
          {data.connectGuidance.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-meta text-muted-foreground">
              {data.connectGuidance.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-meta text-muted-foreground">{data.joinLimitation.statement}</p>
        </div>
      </div>
    </EmptyOrData>
  );
}

// ─── Website, split for Performance → Technical / Visibility → Organic ───────
//
// 2026-09-21 client-nav restructure: the `website` tab's data is one payload
// but now has two homes. These two components render disjoint subsets of the
// same `WebsiteTabData` — see navigation.ts's `CLIENT_PROJECT_NAV` doc comment
// for which piece went where and why presence was folded into Organic rather
// than getting its own destination. `WebsiteTab` above is left as-is for the
// legacy `/results` screen, which still exists and still needs the whole
// payload in one place.

/** Performance → Technical: the site-health half of the `website` tab. */
export function WebsiteTechnicalPanel({ section }: { section: OverviewSection<WebsiteTabData> }) {
  const data = section.data;
  if (!data) {
    return (
      <Card>
        <CardContent className="py-4 text-table text-muted-foreground">{section.reason}</CardContent>
      </Card>
    );
  }

  return (
    <EmptyOrData section={section} emptyCopy="We have not checked your website yet.">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <MetricTile
            label="Site health"
            value={data.health.state === 'unknown' ? null : data.health.issueCount}
            unit={data.health.issueCount === 1 ? 'issue' : 'issues'}
            note={data.health.label}
            direction="neutral"
          />
        </div>

        {data.importantPages.length > 0 ? (
          <div className="space-y-2">
            <TabHeading title="Pages that matter" context={`${data.importantPages.length} page(s)`} />
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.importantPages.map((page) => (
                <li key={page.canonicalUrl} className="space-y-1 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-table font-medium">
                      {page.title ?? urlToPath(page.canonicalUrl)}
                    </span>
                    <span
                      className={cn(
                        'text-meta',
                        page.health === 'needs-attention' ? 'text-warning-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {page.healthLabel}
                    </span>
                  </div>
                  <p className="text-meta text-muted-foreground">{urlToPath(page.canonicalUrl)}</p>
                  <p className="text-meta text-muted-foreground">{page.nextAction}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="space-y-2">
          <TabHeading title="Where this comes from" />
          <p className="text-meta text-muted-foreground">
            Site check: {data.sourceAvailability.technicalCheck.label}
            {data.sourceAvailability.technicalCheck.lastCheckedAt ? (
              <>
                {' '}
                · last checked <Timestamp value={data.sourceAvailability.technicalCheck.lastCheckedAt} dateOnly />
              </>
            ) : null}
          </p>
        </div>
      </div>
    </EmptyOrData>
  );
}

/**
 * Performance → Visibility → Organic: the Google-search half of the `website`
 * tab, plus the former `presence` tab folded in below it (social/directory
 * profiles — the judgment call navigation.ts documents).
 */
export function WebsiteOrganicPanel({
  websiteSection,
  presenceSection,
}: {
  websiteSection: OverviewSection<WebsiteTabData>;
  presenceSection: OverviewSection<OnlinePresenceTabData> | null;
}) {
  const data = websiteSection.data;

  return (
    <div className="space-y-8">
      {!data ? (
        <Card>
          <CardContent className="py-4 text-table text-muted-foreground">{websiteSection.reason}</CardContent>
        </Card>
      ) : (
        <EmptyOrData section={websiteSection} emptyCopy="We have not checked your search performance yet.">
          <div className="space-y-5">
            <div id="google" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <MetricTile label="Clicks from Google" value={data.google.clicks} unit="clicks" direction="neutral" />
              <MetricTile
                label="Times you appeared in Google"
                value={data.google.impressions}
                unit="impressions"
                direction="neutral"
              />
              <MetricTile label="Sessions on your site" value={data.google.sessions} unit="sessions" direction="neutral" />
            </div>

            {data.google.position !== null ? (
              <p className="text-meta text-muted-foreground">
                Average position in Google search results: {formatNumber(data.google.position)}.
              </p>
            ) : null}

            <div className="space-y-1">
              <TabHeading title="How the windows line up" />
              <p className={cn('text-meta', data.windows.aligned ? 'text-muted-foreground' : 'text-warning-foreground')}>
                {data.windows.note}
              </p>
              {data.windows.coarserComparison ? (
                <p className="text-meta text-warning-foreground">
                  The comparison uses the coarser of the two windows, so the finer-grained side is not overstated.
                </p>
              ) : null}
            </div>

            {data.insights.length > 0 ? (
              <div className="space-y-2">
                <TabHeading title="What we found" context={`${data.insights.length} finding(s)`} />
                <ul className="space-y-2">
                  {data.insights.map((insight) => (
                    <li key={insight.message} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        {insight.crossSource ? (
                          <span className="text-meta font-medium text-primary">Seen across sources</span>
                        ) : null}
                        <span
                          className={cn(
                            'text-meta',
                            insight.severity === 'high' ? 'text-warning-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {insight.severity} priority
                        </span>
                      </div>
                      <p className="mt-1 text-table">{insight.message}</p>
                      <p className="text-meta text-muted-foreground">{insight.actionTarget}</p>
                      <p className="text-meta text-muted-foreground">{insight.limitations}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <TabHeading title="Where these numbers come from" />
              <ul className="space-y-1 text-meta text-muted-foreground">
                <li>
                  Google Search Console: {data.sourceAvailability.searchConsole.label}
                  {data.sourceAvailability.searchConsole.expired ? ' (the connection has expired)' : ''}
                </li>
                <li>
                  Google Analytics: {data.sourceAvailability.analytics.label}
                  {data.sourceAvailability.analytics.expired ? ' (the connection has expired)' : ''}
                </li>
              </ul>
              {data.connectGuidance.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-5 text-meta text-muted-foreground">
                  {data.connectGuidance.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-meta text-muted-foreground">{data.joinLimitation.statement}</p>
            </div>
          </div>
        </EmptyOrData>
      )}

      {presenceSection ? (
        <div className="space-y-2 border-t border-border pt-6">
          <TabHeading title="Where you're found beyond search" />
          <PresenceTab section={presenceSection} />
        </div>
      ) : null}
    </div>
  );
}

function urlToPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? parsed.host : parsed.pathname;
  } catch {
    return url;
  }
}

// ─── AI visibility ───────────────────────────────────────────────────────────

function AiVisibilityTab({ section }: { section: OverviewSection<AiVisibilityTabData> }) {
  const data = section.data;
  if (!data) {
    return (
      <Card>
        <CardContent className="py-4 text-table text-muted-foreground">{section.reason}</CardContent>
      </Card>
    );
  }

  return (
    <EmptyOrData section={section} emptyCopy="We have not checked how AI answer engines treat you yet.">
      <div className="space-y-5">
        <TabHeading
          title="What we checked"
          context={
            <>
              {data.questionsChecked} of {data.totalQuestions} question(s) checked
              {data.markets.length > 0 ? ` · ${data.markets.join(', ')}` : ''}
              {data.period.finishedAt ? (
                <>
                  {' · '}
                  <Timestamp value={data.period.finishedAt} dateOnly />
                </>
              ) : null}
            </>
          }
        />

        <p className="text-table">{data.headline}</p>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {/* Appeared and recommended are two different counts and stay two
              tiles: being mentioned is not being recommended (§8.2). */}
          <MetricTile
            label="Answers that mentioned you"
            value={data.appeared.of > 0 ? data.appeared.count : null}
            unit={`of ${data.appeared.of}`}
            direction="neutral"
            note={data.appeared.rateValid ? undefined : 'The sample is too small to state a rate.'}
          />
          <MetricTile
            label="Answers that recommended you"
            value={data.recommended && data.recommended.of > 0 ? data.recommended.count : null}
            unit={data.recommended ? `of ${data.recommended.of}` : undefined}
            direction="neutral"
            note={
              data.recommended
                ? data.recommended.rateValid
                  ? undefined
                  : 'The sample is too small to state a rate.'
                : 'This was not measured in this check.'
            }
          />
          <MetricTile
            label="Questions asked"
            value={data.totalQuestions > 0 ? data.totalQuestions : null}
            unit="questions"
            direction="neutral"
          />
          <MetricTile label="Status" value={null} note={data.statusLabel} />
        </div>

        {data.headlines.length > 0 ? (
          <div className="space-y-1">
            <TabHeading title="What that means" />
            <ul className="list-disc space-y-0.5 pl-5 text-table text-muted-foreground">
              {data.headlines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {data.disclosedFailures.length > 0 ? (
          <Alert>
            <Info aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Parts of this check that did not complete</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {data.disclosedFailures.map((failure) => (
                  <li key={`${failure.label}:${failure.market ?? ''}`}>
                    {failure.label}
                    {failure.market ? ` (${failure.market})` : ''} — {failure.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {data.surfaces.length > 0 ? (
          <div className="space-y-2">
            <TabHeading title="Where you were looked for" />
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.surfaces.map((surface) => (
                <li
                  key={`${surface.label}:${surface.market ?? ''}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 p-2"
                >
                  <span className="text-table">
                    {surface.label}
                    {surface.market ? <span className="text-meta text-muted-foreground"> · {surface.market}</span> : null}
                  </span>
                  <span
                    className={cn(
                      'text-meta',
                      surface.status === 'completed' ? 'text-muted-foreground' : 'text-warning-foreground',
                    )}
                  >
                    {surface.statusLabel}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-meta text-muted-foreground">
          Question set version {data.details.questionSetVersion} · {data.details.runCount} run(s) per question ·
          sampling tier {data.details.tier}.
        </p>
      </div>
    </EmptyOrData>
  );
}

// ─── Online presence ─────────────────────────────────────────────────────────

function PresenceTab({ section }: { section: OverviewSection<OnlinePresenceTabData> }) {
  const data = section.data;
  if (!data) {
    return (
      <Card>
        <CardContent className="py-4 text-table text-muted-foreground">{section.reason}</CardContent>
      </Card>
    );
  }

  const groups = [...new Set(data.accounts.map((account) => account.group))].sort();

  return (
    <EmptyOrData section={section} emptyCopy="We have not found any of your online profiles yet.">
      <div className="space-y-5">
        <TabHeading
          title="Profiles we know are yours"
          context={`${data.counts.total} confirmed · ${data.accounts.length} found${
            data.counts.needsConfirmation > 0 ? ` · ${data.counts.needsConfirmation} to confirm` : ''
          }`}
        />

        {groups.map((group) => (
          /* The group id is the anchor the score's social buckets link to. */
          <div key={group} id={group} className="space-y-2">
            <TabHeading title={groupLabel(group)} />
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.accounts
                .filter((account) => account.group === group)
                .map((account) => (
                  // Keyed by platform + url, not platform alone: one platform
                  // can legitimately hold several of the company's pages (the
                  // store's uniqueness is per url), and two rows sharing a key
                  // would silently drop one.
                  <li key={`${account.platform}:${account.url}`} className="flex flex-wrap items-baseline justify-between gap-2 p-2">
                    <span className="text-table">
                      {account.label}
                      <span className="ml-2 text-meta text-muted-foreground">{account.statusLabel}</span>
                    </span>
                    <span className="text-meta">
                      <ExternalLinkText href={account.url}>{urlToPath(account.url)}</ExternalLinkText>
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        ))}

        {data.relevantNotFound.length > 0 ? (
          <div className="space-y-2">
            <TabHeading title="Profiles that apply to you, where we found nothing yet" />
            <p className="text-meta text-muted-foreground">
              These are places a business like yours is usually expected to appear. Finding nothing is a fact
              about our search, not a statement that the profile does not exist.
            </p>
            <ul className="flex flex-wrap gap-2">
              {data.relevantNotFound.map((gap) => (
                <li
                  key={gap.platform}
                  className="rounded-full border border-border px-3 py-1 text-meta text-muted-foreground"
                >
                  {gap.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-meta text-muted-foreground">
          Profiles are grouped by kind so a listing is not read as an audience. Your delivery team can add
          anything we could not find.
        </p>
      </div>
    </EmptyOrData>
  );
}

function groupLabel(group: string): string {
  switch (group) {
    case 'social':
      return 'Social profiles';
    case 'directory':
      return 'Directories';
    case 'review':
      return 'Review sites';
    case 'marketplace':
      return 'Marketplaces';
    default:
      return group.charAt(0).toUpperCase() + group.slice(1);
  }
}

// ─── Competitors ─────────────────────────────────────────────────────────────

function CompetitorsTab({ section }: { section: OverviewSection<CompetitorsTabData> }) {
  const data = section.data;
  if (!data) {
    return (
      <Card>
        <CardContent className="py-4 text-table text-muted-foreground">{section.reason}</CardContent>
      </Card>
    );
  }

  return (
    <EmptyOrData section={section} emptyCopy="We are not tracking any competitors for you yet.">
      <div className="space-y-5">
        <TabHeading
          title="Who we compare you with"
          context={`${data.competitors.length} tracked · comparison built ${formatIsoDate(data.generatedAt)}`}
        />
        {/* The comparison is a frozen one: a rival added later does not change
            what an earlier comparison said. */}
        <p className="text-meta text-muted-foreground">{data.note}</p>

        {data.competitors.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.competitors.map((competitor) => (
              <li key={`${competitor.name}:${competitor.domain ?? ''}`} className="space-y-1 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-table font-medium">{competitor.name}</span>
                  {competitor.domain ? (
                    <span className="text-meta text-muted-foreground">{competitor.domain}</span>
                  ) : null}
                </div>
                <p className="text-meta text-muted-foreground">
                  In AI answers: {competitor.aeoStatusLabel} · In search results: {competitor.serpStatusLabel}
                  {competitor.seoScore !== null ? ` · site score ${formatNumber(competitor.seoScore)}` : ''}
                </p>
                {competitor.serp ? (
                  <p className="text-meta text-muted-foreground">
                    Appeared {competitor.serp.occurrences} time(s) in our sample
                    {competitor.serp.bestRank !== null ? `, best position ${competitor.serp.bestRank}` : ''}
                    {competitor.serp.sampleKeyword ? ` (sample: “${competitor.serp.sampleKeyword}”)` : ''}.
                  </p>
                ) : null}
                {competitor.presencePlatforms.length > 0 ? (
                  <p className="text-meta text-muted-foreground">
                    Present on: {competitor.presencePlatforms.join(', ')}
                  </p>
                ) : null}
                {competitor.seoIssues.length > 0 ? (
                  <ul className="list-disc pl-5 text-meta text-muted-foreground">
                    {competitor.seoIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="space-y-3">
          <DiffBlock
            title="Online presence"
            diff={data.diffs.presence}
            emptyCopy="No presence comparison has been recorded yet."
          />
          <DiffBlock
            title="Site technology"
            diff={data.diffs.tech}
            emptyCopy="No technology comparison has been recorded yet."
          />
          <DiffBlock
            title="Structured data"
            diff={data.diffs.schema}
            emptyCopy="No structured-data comparison has been recorded yet."
          />
        </div>

        {data.reviews.client.length > 0 ? (
          <div className="space-y-2">
            <TabHeading title="Your reviews, as we recorded them" />
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.reviews.client.map((review) => (
                <li key={review.label} className="flex flex-wrap items-baseline justify-between gap-2 p-2">
                  <span className="text-table">{review.label}</span>
                  <span className="text-meta text-muted-foreground">
                    {review.found
                      ? review.rating !== null
                        ? `${formatNumber(review.rating)}${review.scale ? ` / ${review.scale}` : ''}${
                            review.ratingCount !== null ? ` · ${formatNumber(review.ratingCount)} reviews` : ''
                          }`
                        : 'Found, no rating recorded'
                      : 'Not found in our checks'}
                  </span>
                </li>
              ))}
            </ul>
            {data.reviews.note ? (
              <p className="text-meta text-muted-foreground">{data.reviews.note}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </EmptyOrData>
  );
}

/**
 * One comparison block. "Where you are ahead" renders alongside "where they
 * are ahead" on purpose: the same read, in both directions, rather than a
 * systematically one-sided panel.
 */
function DiffBlock({
  title,
  diff,
  emptyCopy,
}: {
  title: string;
  diff: CompetitorsTabDiff;
  emptyCopy: string;
}) {
  const nothing =
    diff.clientOnly.length === 0 && diff.competitorsOnly.length === 0 && diff.shared.length === 0 && diff.client.length === 0;

  return (
    <div className="space-y-1 rounded-md border border-border p-3">
      <TabHeading title={title} />
      {nothing ? (
        <p className="text-meta text-muted-foreground">{emptyCopy}</p>
      ) : (
        <>
          {diff.client.length > 0 ? (
            <p className="text-meta text-muted-foreground">You: {diff.client.join(', ')}</p>
          ) : null}
          {diff.competitorsOnly.length > 0 ? (
            <p className="text-meta text-muted-foreground">
              They have, you do not: {diff.competitorsOnly.map((line) => line.key).join(', ')}
            </p>
          ) : null}
          {diff.clientOnly.length > 0 ? (
            <p className="text-meta text-muted-foreground">
              You have, they do not: {diff.clientOnly.map((line) => line.key).join(', ')}
            </p>
          ) : null}
          {diff.shared.length > 0 ? (
            <p className="text-meta text-muted-foreground">
              Both: {diff.shared.map((line) => line.key).join(', ')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function formatIsoDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'at a date we could not read';
  return date.toLocaleDateString();
}

/** Local empty-state re-export: the tabs use the §3.5 not-measured variant. */
export function NotMeasuredNote({ subject }: { subject: string }) {
  return (
    <EmptyState variant="not-measured" subject={subject} prerequisite="It fills in after the first check runs." />
  );
}

/** Rendered in the empty-tab case: a link to the screen that can change it. */
export function PanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-primary underline underline-offset-4">
      {children}
    </Link>
  );
}
