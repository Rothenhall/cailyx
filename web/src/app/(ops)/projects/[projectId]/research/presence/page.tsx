'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ExternalLink, RefreshCw } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { Textarea } from '@/components/ui/textarea';
import {
  addPresenceAccount,
  confirmPresenceCandidate,
  getPresenceInventory,
  getResearchScope,
  listPresenceDiscoveries,
  pullBusinessProfile,
  pullDirectoryRatings,
  rejectPresenceCandidate,
  removePresenceAccount,
  runPresenceDiscovery,
  setPresenceApplicability,
  updatePresenceAccount,
  type DiscoveryRun,
  type FootprintItem,
  type PlatformApplicability,
  type PresenceAccount,
  type PresenceGap,
  type PresenceInventory,
  type ResearchScope,
} from '@/services/research-library';

/** §11.1 — the groups a card belongs to, from the account/gap's own `group`. */
const SOCIAL_GROUPS = new Set(['social']);
const LISTING_GROUPS = new Set(['directory', 'review', 'marketplace']);
// Everything else (publishing, personal, other) reads as "Other relevant profiles".
function presenceSectionOf(group: string): 'social' | 'listings' | 'other' {
  if (SOCIAL_GROUPS.has(group)) return 'social';
  if (LISTING_GROUPS.has(group)) return 'listings';
  return 'other';
}

/**
 * DP01 — Digital footprint.
 *
 * design_plan.md §4.3: *"Found/supplied/candidate/missing accounts, discovery
 * history, confirm/correct/remove links"*.
 *
 * Four rules from the plan are load-bearing on this screen, and each one has a
 * place below where it is enforced rather than remembered:
 *
 *  1. **A candidate is not an account.** §1.5 / G14: a search-suggested row
 *     carries `discovered-candidate` provenance, is counted separately, and
 *     never satisfies a gap. It reaches the account list only after a human
 *     confirms it — search cannot tell `site:instagram.com "HubSpot"` from a
 *     similarly named stranger.
 *  2. **`unverified` is not `missing`.** Instagram and Facebook serve login
 *     walls and LinkedIn answers datacentre IPs with `999`, so a profile linked
 *     from the client's own footer that fails its check is `unverified` — the
 *     routine outcome, not a fault. Both are shown with their verbatim reason.
 *  3. **A gap is an observation.** "No account found for this platform" is not
 *     a failure and is never toned `danger`; it is the question the operator is
 *     being asked.
 *  4. **`not-checked` is an answer of its own.** In the rest-of-footprint
 *     section, a module that has not looked is not the same as a module that
 *     looked and found nothing.
 *
 * The counts are shown as separate numbers, never summed into a completeness
 * percentage — §1.5 makes presence completeness its own measurement, and a
 * "74% present" would be a number no endpoint here produces.
 */
const TAB_DEFAULTS = { tab: 'social' };

export default function DigitalFootprintPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [inventory, setInventory] = useState<PresenceInventory | null>(null);
  const [runs, setRuns] = useState<DiscoveryRun[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const [tabState, setTabState] = useUrlState(TAB_DEFAULTS);
  const tab = tabState.tab;

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [correcting, setCorrecting] = useState<PresenceAccount | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PresenceAccount | null>(null);
  const [pendingReject, setPendingReject] = useState<PresenceAccount | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [overriding, setOverriding] = useState<PlatformApplicability | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [inventoryResult, runsResult] = await Promise.all([
          getPresenceInventory(projectId, { signal }),
          listPresenceDiscoveries(projectId, { signal, limit: 10 }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setInventory(inventoryResult);
        setRuns(runsResult);
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

  /** Stable reference: the two derivations below depend on it, not on `inventory`. */
  const accounts = useMemo(() => inventory?.accounts ?? [], [inventory]);
  const candidates = useMemo(
    () => accounts.filter((account) => account.state === 'candidate'),
    [accounts],
  );
  const held = useMemo(
    () => accounts.filter((account) => account.state !== 'candidate'),
    [accounts],
  );

  // §11.1 — one screen, contextual groups (Social accounts / Business listings
  // & reviews / Other relevant profiles), not a tab per discovery state. Every
  // held account, candidate and gap sorts into exactly one of the three.
  const applicability = useMemo(() => inventory?.applicability ?? [], [inventory]);
  const notRelevant = useMemo(
    () => applicability.filter((a) => a.status === 'not-relevant'),
    [applicability],
  );
  function forSection(section: 'social' | 'listings' | 'other') {
    return {
      held: held.filter((a) => presenceSectionOf(a.group) === section),
      candidates: candidates.filter((a) => presenceSectionOf(a.group) === section),
      gaps: (inventory?.gaps ?? []).filter((g) => presenceSectionOf(g.group) === section),
    };
  }
  const socialSection = forSection('social');
  const listingsSection = forSection('listings');
  const otherSection = forSection('other');

  async function handleConfirm(account: PresenceAccount) {
    setActionError(null);
    try {
      await confirmPresenceCandidate(projectId, account.id);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  async function handleReject(account: PresenceAccount, reason: string) {
    setActionError(null);
    try {
      // P05 §11.4 — "Not ours" stores a tombstone (normalized URL/platform/
      // project scope + reason + actor), not a plain delete. Without this the
      // next discovery/SERP sweep can recreate the identical rejected
      // candidate on its next run.
      await rejectPresenceCandidate(projectId, account.id, reason);
      setPendingReject(null);
      setRejectReason('');
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  async function handleOverride(platform: PlatformApplicability, status: PlatformApplicability['status'], reason: string) {
    setActionError(null);
    try {
      await setPresenceApplicability(projectId, platform.platform, status, reason);
      setOverriding(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  async function handleRemove(account: PresenceAccount) {
    setActionError(null);
    try {
      await removePresenceAccount(projectId, account.id);
      setPendingRemove(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Digital footprint" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!inventory) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: inventory.domain,
          projectName: scope?.projectName,
          mode: 'live',
        }}
      />
      {scopeReadFailed ? (
        <p className="text-meta text-muted-foreground">
          The project context could not be read, so the client name is not shown above. The domain
          below is the one the footprint inventory reports.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Online presence' },
        ]}
        title="Online presence"
        context={
          <>
            Your business profiles, customer reviews, and social activity in one place ·{' '}
            {inventory.counts.total} company account
            {inventory.counts.total === 1 ? '' : 's'} held ·{' '}
            {inventory.counts.candidates} candidate
            {inventory.counts.candidates === 1 ? '' : 's'} awaiting a decision ·{' '}
            {inventory.gaps.length} relevant platform
            {inventory.gaps.length === 1 ? '' : 's'} with no account
          </>
        }
        primaryAction={{ label: 'Run discovery', onClick: () => setDiscoverOpen(true) }}
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

      {inventory.lastRun ? (
        <Alert>
          {inventory.lastRun.status === 'failed' ? (
            <AlertTitle>
              The last discovery run failed — earlier findings are still on file
            </AlertTitle>
          ) : (
            <AlertTitle>Last discovery run: {inventory.lastRun.status}</AlertTitle>
          )}
          <AlertDescription>
            <p className="text-table">
              Started <Timestamp value={inventory.lastRun.startedAt} />
              {inventory.lastRun.finishedAt ? (
                <>
                  {' · finished '}
                  <Timestamp value={inventory.lastRun.finishedAt} />
                </>
              ) : null}
            </p>
            <p className="mt-1 text-meta">
              {inventory.lastRun.pagesFetched} page
              {inventory.lastRun.pagesFetched === 1 ? '' : 's'} fetched ·{' '}
              {inventory.lastRun.confirmed} confirmed · {inventory.lastRun.unverified} unverified ·{' '}
              {inventory.lastRun.candidates} candidate
              {inventory.lastRun.candidates === 1 ? '' : 's'} raised
            </p>
            {inventory.lastRun.serpSkipped ? (
              <p className="mt-1 text-meta">
                The paid search sweep did not run this time: {inventory.lastRun.serpSkipped}
              </p>
            ) : null}
            {inventory.lastRun.error ? (
              <p className="mt-1 text-meta">{inventory.lastRun.error}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Held, by kind</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: 'Company accounts held', value: inventory.counts.total },
              { label: 'Confirmed', value: inventory.counts.confirmed },
              { label: 'Found but unverified', value: inventory.counts.unverified },
              { label: 'Social profiles', value: inventory.counts.social },
              { label: 'Directories, reviews, marketplaces', value: inventory.counts.listing },
              { label: 'Entered by an operator', value: inventory.counts.manual },
              { label: 'Candidates awaiting a decision', value: inventory.counts.candidates },
              { label: 'Founder personal profiles (not company reach)', value: inventory.counts.personal },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg border border-border p-3">
                <dt className="text-meta text-muted-foreground">{tile.label}</dt>
                <dd className="mt-1 text-kpi tabular-nums text-foreground">{tile.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-meta text-muted-foreground">
            These are counted separately on purpose. A candidate is a search guess, not an account;
            a personal profile is a founder&rsquo;s, not the company&rsquo;s. Neither is added into
            the held total, and no completeness percentage is derived from them — design_plan §1.5
            keeps presence completeness its own measurement.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">What the footprint says</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-meta text-muted-foreground">
            Expected set derived from{' '}
            <span className="font-medium text-foreground">
              {inventory.assessment.businessProfileLabel}
            </span>
            {inventory.assessment.inferredFrom ? (
              <>
                , inferred from the category text &ldquo;
                <span className="evidence">{inventory.assessment.inferredFrom}</span>&rdquo;
              </>
            ) : (
              ' — the category was not identified, so the broad social set is used'
            )}
            . A wrong classification shows up here so it can be argued with rather than silently
            shaping which platforms count as gaps.
          </p>

          {inventory.assessment.headlines.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="Presence assessment"
              prerequisite="The assessment is built from discovered and supplied accounts. Run a discovery pass, or add an account by URL."
              layout="inline"
            />
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-table">
              {inventory.assessment.headlines.map((headline) => (
                <li key={headline}>{headline}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(value) => setTabState({ tab: value }, { push: true })}>
        <TabsList>
          <TabsTrigger value="social">
            Social accounts ({socialSection.held.length + socialSection.candidates.length})
          </TabsTrigger>
          <TabsTrigger value="listings">
            Business listings &amp; reviews ({listingsSection.held.length + listingsSection.candidates.length})
          </TabsTrigger>
          <TabsTrigger value="other">
            Other relevant profiles ({otherSection.held.length + otherSection.candidates.length})
          </TabsTrigger>
          <TabsTrigger value="activity">Business profile &amp; activity</TabsTrigger>
          <TabsTrigger value="footprint">Rest of the footprint</TabsTrigger>
          <TabsTrigger value="runs">Discovery history</TabsTrigger>
        </TabsList>

        {(
          [
            { key: 'social' as const, label: 'Social accounts', data: socialSection },
            { key: 'listings' as const, label: 'Business listings & reviews', data: listingsSection },
            { key: 'other' as const, label: 'Other relevant profiles', data: otherSection },
          ]
        ).map(({ key, label, data }) => (
          <TabsContent key={key} value={key} className="space-y-4">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-subsection">{label}</CardTitle>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  Add account by URL
                </Button>
              </CardHeader>
              <CardContent className="space-y-4 pt-2">
                {data.held.length === 0 && data.candidates.length === 0 && data.gaps.length === 0 ? (
                  <EmptyState
                    variant="not-measured"
                    subject={label}
                    prerequisite="Nothing relevant in this group yet — no account found or supplied, and nothing is currently expected here."
                    layout="inline"
                  />
                ) : (
                  <>
                    {data.held.length > 0 ? (
                      <AccountTable accounts={data.held} onCorrect={setCorrecting} onRemove={setPendingRemove} />
                    ) : null}
                    {data.candidates.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-meta text-muted-foreground">
                          Suggested by search, not by reading the client&rsquo;s own site. Never counted as an
                          account until a person confirms it — see plain-English evidence below, not a raw score.
                        </p>
                        <CandidateTable
                          candidates={data.candidates}
                          onConfirm={handleConfirm}
                          onReject={(account) => {
                            setPendingReject(account);
                            setRejectReason('');
                          }}
                        />
                      </div>
                    ) : null}
                    {data.gaps.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-meta text-muted-foreground">
                          Expected for this kind of business and not found yet — an{' '}
                          <strong>observation</strong>, never a fault.
                        </p>
                        <GapTable gaps={data.gaps} />
                      </div>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        ))}

        <TabsContent value="activity" className="space-y-4">
          {/* §11.1's third strand, merged from the former "Presence insights" page rather than
              kept as a second screen. §11.6 — this tab only ever says "Public profile found" from
              discovery evidence; "Connected for publishing" is the publishing module's own claim. */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Business profile &amp; reviews</CardTitle>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setActionError(null);
                    try {
                      await pullBusinessProfile(projectId);
                      await load();
                    } catch (caught) {
                      setActionError(toApiError(caught));
                    }
                  }}
                >
                  Pull business profile
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setActionError(null);
                    try {
                      await pullDirectoryRatings(projectId);
                      await load();
                    } catch (caught) {
                      setActionError(toApiError(caught));
                    }
                  }}
                >
                  Read directory ratings
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              {inventory.businessProfile ? (
                <dl className="grid gap-2 text-table sm:grid-cols-2">
                  <div>
                    <dt className="text-meta text-muted-foreground">Name</dt>
                    <dd>{inventory.businessProfile.name ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Rating</dt>
                    <dd>
                      {inventory.businessProfile.rating ?? 'No rating on file'}
                      {inventory.businessProfile.reviewCount !== null
                        ? ` (${formatNumber(inventory.businessProfile.reviewCount)} reviews)`
                        : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Fetched</dt>
                    <dd><Timestamp value={inventory.businessProfile.fetchedAt} /></dd>
                  </div>
                </dl>
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="Business profile"
                  prerequisite="Never pulled for this project — DataForSEO Business Data spends real credit per pull."
                  layout="inline"
                />
              )}
              {inventory.reviews.length > 0 ? (
                <ul className="space-y-1 text-table">
                  {inventory.reviews.map((review) => (
                    <li key={`${review.platform}-${review.id}`}>
                      <span className="font-medium">{review.platform}</span>: {review.rating ?? '—'} ·{' '}
                      {review.reviewCount !== null ? `${formatNumber(review.reviewCount)} reviews` : 'count unknown'}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Social activity — performance, not style</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                §11.5 — posting cadence and reach only. Reply/response-rate is never calculated from
                captions alone; where reply activity was not collected this omits the metric rather
                than guessing. The confirmed writing style itself lives in Content → Writing style and
                is never overwritten by this collection.
              </p>
              {inventory.socialActivity.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="Social activity"
                  prerequisite="No Apify social-activity pull has been run for this project yet — it spends real account credit and is opt-in only."
                  layout="inline"
                />
              ) : (
                <ul className="space-y-2 text-table">
                  {inventory.socialActivity.map((row) => (
                    <li key={row.platform} className="rounded-lg border border-border p-3">
                      <p className="font-medium">{row.platform}</p>
                      <p className="text-meta text-muted-foreground">
                        {row.followerCount !== null ? `${formatNumber(row.followerCount)} followers · ` : ''}
                        {row.postsSampled} post{row.postsSampled === 1 ? '' : 's'} in the observed sample
                        {row.lastPostAt ? (
                          <>
                            {' · last post '}
                            <Timestamp value={row.lastPostAt} />
                          </>
                        ) : (
                          ' · no recent posts in the sample'
                        )}
                      </p>
                      <p className="text-meta text-muted-foreground">
                        {row.avgEngagement !== null
                          ? `Average engagement: ${formatNumber(Math.round(row.avgEngagement))} per post`
                          : 'Reply activity is not available.'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="footprint" className="space-y-4">
          {inventory.footprint.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <EmptyState
                  variant="not-measured"
                  subject="The wider footprint"
                  prerequisite="This section collects what the other research modules have found — identity, owned properties, connected data, answer engines and competitors. Nothing has reported yet."
                />
              </CardContent>
            </Card>
          ) : (
            inventory.footprint.map((section) => (
              <Card key={section.key}>
                <CardHeader>
                  <CardTitle className="text-subsection">{section.label}</CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  <FootprintTable items={section.items} caption={section.label} />
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="runs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Discovery runs</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <DiscoveryRunTable runs={runs ?? []} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {notRelevant.length > 0 ? (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-subsection text-foreground">
            Not relevant for this business ({notRelevant.length})
          </summary>
          <p className="mt-2 text-meta text-muted-foreground">
            §11.1 — shown here, in settings/details, not as an empty tab elsewhere on this page. A
            platform reads &ldquo;not relevant&rdquo; from the applicability policy below, never
            because nothing was found for it.
          </p>
          <ul className="mt-3 space-y-2">
            {notRelevant.map((platform) => (
              <li key={platform.platform} className="flex flex-wrap items-center justify-between gap-2 text-table">
                <span>
                  <span className="font-medium">{platform.label}</span>{' '}
                  <span className="text-muted-foreground">— {platform.reason}</span>
                  {platform.overridden ? (
                    <span className="ml-2 text-meta text-muted-foreground">(staff override)</span>
                  ) : null}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setOverriding(platform)}>
                  Mark relevant instead
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {inventory.assessment.notMeasured.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Not reflected in the numbers above</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="space-y-2">
              {inventory.assessment.notMeasured.map((note) => (
                <li key={note.label} className="flex flex-wrap items-baseline gap-2 text-table">
                  <ProvenanceBadge kind="unmeasured" label={capabilityStateLabel(note.state)} />
                  <span className="font-medium">{note.label}</span>
                  <span className="text-muted-foreground">{note.note}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <DiscoveryDialog
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
        projectId={projectId}
        onDone={() => {
          setDiscoverOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <AddAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        projectId={projectId}
        onDone={() => {
          setAddOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <CorrectAccountDialog
        open={correcting !== null}
        onOpenChange={(open) => {
          if (!open) setCorrecting(null);
        }}
        projectId={projectId}
        account={correcting}
        onDone={() => {
          setCorrecting(null);
          void load();
        }}
        onError={setActionError}
      />

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title="Remove account from the inventory"
        confirmLabel="Remove account"
        destructive
        targetLabel="Account"
        target={pendingRemove ? `${pendingRemove.label} — ${pendingRemove.url}` : ''}
        effect={
          <>
            The row is deleted from Cailyx&rsquo;s inventory. This does not touch the platform, and
            nothing is unpublished. A later discovery run may find the same link again.
          </>
        }
        scope={<>Only this project&rsquo;s footprint is affected.</>}
        onConfirm={async () => {
          if (pendingRemove) await handleRemove(pendingRemove);
        }}
        onReload={() => void load()}
      />

      <Dialog
        open={pendingReject !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingReject(null);
            setRejectReason('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Not ours</DialogTitle>
            <DialogDescription>
              {pendingReject ? `${pendingReject.label} — ${pendingReject.url}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Why is this not the client&rsquo;s account?</Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="e.g. different company, same name — wrong city in their bio"
              rows={3}
            />
            <p className="text-meta text-muted-foreground">
              Stored as a tombstone keyed to this exact URL — a later discovery or search run will not
              suggest it again. This can be reconsidered later; nothing is permanently destroyed.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingReject(null);
                setRejectReason('');
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!rejectReason.trim()}
              onClick={async () => {
                if (pendingReject) await handleReject(pendingReject, rejectReason);
              }}
            >
              Not ours
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={overriding !== null}
        onOpenChange={(open) => {
          if (!open) setOverriding(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as relevant</DialogTitle>
            <DialogDescription>
              {overriding ? `${overriding.label} — currently: ${overriding.reason}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="override-reason">Why is this relevant for this client?</Label>
            <Textarea id="override-reason" placeholder="e.g. they do have a showroom customers visit" rows={3} />
            <p className="text-meta text-muted-foreground">
              Versioned and persisted — this survives the next rediscovery run rather than being
              recomputed away.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverriding(null)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const el = document.getElementById('override-reason') as HTMLTextAreaElement | null;
                const reason = el?.value.trim() || 'Marked relevant by staff override.';
                if (overriding) await handleOverride(overriding, 'relevant', reason);
              }}
            >
              Mark relevant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AccountTable({
  accounts,
  onCorrect,
  onRemove,
}: {
  accounts: PresenceAccount[];
  onCorrect: (account: PresenceAccount) => void;
  onRemove: (account: PresenceAccount) => void;
}) {
  const columns: ReadonlyArray<ColumnDef<PresenceAccount>> = [
    {
      key: 'platform',
      header: 'Platform',
      accessor: (row) => row.label,
      sortable: true,
      width: 150,
    },
    {
      key: 'url',
      header: 'Account',
      accessor: (row) => row.url,
      width: 300,
      cellClassName: 'whitespace-normal',
      render: (row) => (
        <div className="space-y-0.5">
          <AccountLink url={row.url} />
          {row.handle ? (
            <p className="text-meta text-muted-foreground">handle: {row.handle}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      accessor: (row) => row.state,
      sortable: true,
      width: 140,
      render: (row) => <StatusPill label={presenceStateLabel(row.state)} tone={presenceStateTone(row.state)} />,
    },
    {
      key: 'provenance',
      header: 'How we know',
      accessor: (row) => row.sourceLabel,
      width: 220,
      cellClassName: 'whitespace-normal',
      render: (row) => (
        <div className="space-y-1">
          <ProvenanceBadge
            kind={row.source === 'manual' ? 'operator-supplied' : 'measured'}
            label={row.sourceLabel}
          />
          {row.foundOn ? (
            <p className="text-meta text-muted-foreground">
              Found on <span className="evidence">{row.foundOn}</span>
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'entity',
      header: 'Whose profile',
      accessor: (row) => row.entity,
      sortable: true,
      width: 150,
      render: (row) => (
        <span className="text-meta">{presenceEntityLabel(row.entity)}</span>
      ),
    },
    {
      key: 'nameConsistency',
      header: 'Name check',
      accessor: (row) => row.nameConsistency,
      width: 160,
      render: (row) => (
        <StatusPill
          label={consistencyLabel(row.nameConsistency)}
          tone={consistencyTone(row.nameConsistency)}
        />
      ),
    },
    {
      key: 'verifiedAt',
      header: 'Last checked',
      accessor: (row) => row.verifiedAt,
      sortable: true,
      width: 190,
      emptyLabel: 'Never checked',
      render: (row) => (row.verifiedAt ? <Timestamp value={row.verifiedAt} /> : null),
    },
    {
      key: 'actions',
      header: '',
      width: 160,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onCorrect(row)}>
            Correct
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onRemove(row)}>
            Remove
          </Button>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      caption="Accounts found or supplied"
      columns={columns}
      rows={accounts}
      getRowId={(row) => row.id}
      defaultSort={{ key: 'platform', direction: 'asc' }}
      minTableWidth="76rem"
      searchable
      filters={[
        {
          id: 'state',
          label: 'State',
          options: [
            { value: 'confirmed', label: 'Confirmed' },
            { value: 'unverified', label: 'Found but unverified' },
            { value: 'missing', label: 'No account found' },
          ],
          getValue: (row) => row.state,
        },
      ]}
      rowDetail={(row) => <AccountDetail account={row} />}
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Digital footprint accounts"
          prerequisite="No account has been found or supplied yet. Run a discovery pass over the client's site, or add an account by URL."
        />
      }
    />
  );
}

function AccountDetail({ account }: { account: PresenceAccount }) {
  return (
    <div className="space-y-2 text-table">
      {account.state === 'unverified' ? (
        <p className="text-unmeasured-foreground">
          This profile is linked from the client&rsquo;s own site, but the platform refused the
          check. That is the routine outcome for the walled platforms — it is recorded as unverified
          rather than as missing, because the link is real.
        </p>
      ) : null}
      {account.reason ? (
        <p>
          <span className="text-muted-foreground">Reason the check could not complete:</span>{' '}
          <span className="evidence">{account.reason}</span>
        </p>
      ) : null}
      {account.title ? (
        <p>
          <span className="text-muted-foreground">Page title as fetched:</span>{' '}
          <span className="evidence">{account.title}</span>
        </p>
      ) : null}
      {account.statusCode !== null ? (
        <p className="text-meta text-muted-foreground">HTTP {account.statusCode}</p>
      ) : null}
    </div>
  );
}

function CandidateTable({
  candidates,
  onConfirm,
  onReject,
}: {
  candidates: PresenceAccount[];
  onConfirm: (account: PresenceAccount) => void;
  onReject: (account: PresenceAccount) => void;
}) {
  const columns: ReadonlyArray<ColumnDef<PresenceAccount>> = [
    {
      key: 'platform',
      header: 'Platform',
      accessor: (row) => row.label,
      sortable: true,
      width: 150,
    },
    {
      key: 'url',
      header: 'Suggested profile',
      accessor: (row) => row.url,
      cellClassName: 'whitespace-normal',
      render: (row) => <AccountLink url={row.url} />,
    },
    {
      key: 'confidence',
      header: 'Name-similarity hint',
      accessor: (row) => row.confidence,
      sortable: true,
      align: 'right',
      width: 190,
      emptyLabel: 'Not scored',
      render: (row) =>
        row.confidence === null ? null : (
          <span className="tabular-nums">
            {formatNumber(Math.round(row.confidence * 100))}%
          </span>
        ),
    },
    {
      key: 'provenance',
      header: 'Provenance',
      accessor: () => 'serp',
      width: 200,
      render: () => <ProvenanceBadge kind="discovered-candidate" label="Suggested by search" />,
    },
    {
      key: 'actions',
      header: '',
      width: 220,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onConfirm(row)}>
            Confirm as account
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onReject(row)}>
            Reject
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <p className="text-meta text-muted-foreground">
        The similarity hint is an ordering aid for your eye only. It never promotes a row on its own
        — a high score on the wrong company is still the wrong company.
      </p>
      <DataTable
        caption="Search-suggested candidates"
        columns={columns}
        rows={candidates}
        getRowId={(row) => row.id}
        minTableWidth="64rem"
        emptyState={
          <EmptyState
            variant="not-measured"
            subject="Search-suggested candidates"
            prerequisite="No candidate has been raised. Candidates only appear when a discovery run is told to search the web as well as read the site."
            layout="inline"
          />
        }
      />
    </>
  );
}

function GapTable({ gaps }: { gaps: PresenceGap[] }) {
  const columns: ReadonlyArray<ColumnDef<PresenceGap>> = [
    {
      key: 'platform',
      header: 'Platform',
      accessor: (row) => row.label,
      sortable: true,
      width: 180,
    },
    {
      key: 'group',
      header: 'Category',
      accessor: (row) => row.group,
      sortable: true,
      width: 160,
      render: (row) => <span className="capitalize">{row.group}</span>,
    },
    {
      key: 'observation',
      header: 'Observation',
      accessor: () => 'none',
      cellClassName: 'whitespace-normal',
      render: () => (
        <span className="text-meta text-muted-foreground">
          No account found: not linked from the client&rsquo;s site and not supplied by hand.
        </span>
      ),
    },
    {
      key: 'tone',
      header: 'Status',
      accessor: () => 'unmeasured',
      width: 170,
      render: () => <ProvenanceBadge kind="unmeasured" label="Not found — not a failure" />,
    },
  ];

  return (
    <DataTable
      caption="Expected platforms with no account"
      columns={columns}
      rows={gaps}
      getRowId={(row) => row.platform}
      defaultSort={{ key: 'platform', direction: 'asc' }}
      minTableWidth="56rem"
      emptyState={
        <div className="text-table text-muted-foreground">
          Nothing is outstanding — every platform expected for this kind of business has an account
          on file.
        </div>
      }
    />
  );
}

function FootprintTable({ items, caption }: { items: FootprintItem[]; caption: string }) {
  const columns: ReadonlyArray<ColumnDef<FootprintItem>> = [
    {
      key: 'label',
      header: 'Finding',
      accessor: (row) => row.label,
      sortable: true,
      width: 240,
      cellClassName: 'whitespace-normal',
    },
    {
      key: 'state',
      header: 'State',
      accessor: (row) => row.state,
      sortable: true,
      width: 150,
      render: (row) => (
        <StatusPill label={footprintStateLabel(row.state)} tone={footprintStateTone(row.state)} />
      ),
    },
    {
      key: 'detail',
      header: 'Detail',
      accessor: (row) => row.detail,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No further detail reported',
    },
    {
      key: 'source',
      header: 'Reported by',
      accessor: (row) => row.source,
      sortable: true,
      width: 200,
      // Every number can be traced home to the module that produced it.
      render: (row) => <span className="evidence">{row.source}</span>,
    },
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={items}
      getRowId={(row) => `${row.source}-${row.label}`}
      minTableWidth="58rem"
      emptyState={
        <div className="text-table text-muted-foreground">
          This section has no reported findings.
        </div>
      }
    />
  );
}

function DiscoveryRunTable({ runs }: { runs: DiscoveryRun[] }) {
  const columns: ReadonlyArray<ColumnDef<DiscoveryRun>> = [
    {
      key: 'startedAt',
      header: 'Run',
      accessor: (row) => row.startedAt,
      sortable: true,
      width: 210,
      render: (row) => <Timestamp value={row.startedAt} />,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => <StatusPill label={row.status} tone={discoveryTone(row.status)} />,
    },
    {
      key: 'pagesFetched',
      header: 'Pages',
      accessor: (row) => row.pagesFetched,
      sortable: true,
      align: 'right',
      width: 90,
    },
    {
      key: 'confirmed',
      header: 'Confirmed',
      accessor: (row) => row.confirmed,
      sortable: true,
      align: 'right',
      width: 110,
    },
    {
      key: 'unverified',
      header: 'Unverified',
      accessor: (row) => row.unverified,
      sortable: true,
      align: 'right',
      width: 110,
    },
    {
      key: 'candidates',
      header: 'Candidates raised',
      accessor: (row) => row.candidates,
      sortable: true,
      align: 'right',
      width: 150,
    },
    {
      key: 'serp',
      header: 'Paid search sweep',
      accessor: (row) => row.serpQueries,
      sortable: true,
      width: 240,
      cellClassName: 'whitespace-normal',
      render: (row) => (
        <span className="text-meta">
          {row.serpSkipped ? (
            row.serpSkipped
          ) : (
            <>
              <span className="tabular-nums">{row.serpQueries}</span> quer
              {row.serpQueries === 1 ? 'y' : 'ies'} · vendor charge{' '}
              <span className="tabular-nums">${row.serpCostUsd.toFixed(4)}</span>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'error',
      header: 'Error',
      accessor: (row) => row.error,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No error',
      render: (row) => (row.error ? <span className="evidence">{row.error}</span> : null),
    },
  ];

  return (
    <DataTable
      caption="Discovery run history"
      columns={columns}
      rows={runs}
      getRowId={(row) => row.id}
      defaultSort={{ key: 'startedAt', direction: 'desc' }}
      minTableWidth="76rem"
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Discovery history"
          prerequisite="No discovery run has been made for this project yet."
          layout="inline"
        />
      }
    />
  );
}

function DiscoveryDialog({
  open,
  onOpenChange,
  projectId,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [searchWeb, setSearchWeb] = useState(false);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<DiscoveryRun | null>(null);

  async function submit() {
    setRunning(true);
    setFormError(null);
    setResult(null);
    try {
      const run = await runPresenceDiscovery(projectId, searchWeb);
      setResult(run);
      onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run discovery</DialogTitle>
          <DialogDescription>
            Reads the client&rsquo;s homepage and contact/about pages, pulls profile URLs from
            JSON-LD <code>sameAs</code> and from on-page links, and verifies what can be verified.
            Share widgets and intent links are rejected rather than reported as accounts.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            providerName="the search provider"
            preserveNotice="Existing findings on this page are unchanged."
          />
        ) : null}

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div>
            <Label htmlFor="dp-search-web">Also search Google for unlinked accounts</Label>
            <p className="mt-1 text-meta text-muted-foreground">
              Costs one paid credit per platform swept at the search vendor. Off by default so
              nothing bills by accident. Results arrive as candidates, never as accounts.
            </p>
          </div>
          <Switch id="dp-search-web" checked={searchWeb} onCheckedChange={setSearchWeb} />
        </div>

        {result ? (
          <Alert>
            <AlertTitle>Discovery run {result.status}</AlertTitle>
            <AlertDescription>
              <p className="text-table">
                {result.confirmed} confirmed · {result.unverified} unverified ·{' '}
                {result.candidates} candidate{result.candidates === 1 ? '' : 's'} raised
              </p>
              {result.serpSkipped ? (
                <p className="mt-1 text-meta">Search sweep skipped: {result.serpSkipped}</p>
              ) : (
                <p className="mt-1 text-meta">
                  Search sweep: {result.serpQueries} quer
                  {result.serpQueries === 1 ? 'y' : 'ies'}, vendor charge $
                  {result.serpCostUsd.toFixed(4)}
                </p>
              )}
              {result.error ? <p className="mt-1 text-meta">{result.error}</p> : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={() => void submit()} disabled={running}>
            {running
              ? 'Running…'
              : searchWeb
                ? 'Run discovery with paid search'
                : 'Run free discovery'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAccountDialog({
  open,
  onOpenChange,
  projectId,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  async function submit() {
    setSaving(true);
    setFormError(null);
    try {
      await addPresenceAccount(projectId, url.trim());
      setUrl('');
      onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add account by URL</DialogTitle>
          <DialogDescription>
            For the case discovery cannot cover: an account that exists but is not linked from the
            site. An operator entry outranks the crawler and is never overwritten by a later
            discovery run.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Your URL is still here." />
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="dp-url">Profile URL (required)</Label>
          <Input
            id="dp-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.linkedin.com/company/acme"
            inputMode="url"
          />
          <p className="text-meta text-muted-foreground">
            Paste the profile itself, not a post, a share link or a search result — the platform and
            handle are derived from the URL rather than asked for.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || url.trim() === ''}>
            {saving ? 'Adding…' : 'Add account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CorrectAccountDialog({
  open,
  onOpenChange,
  projectId,
  account,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  account: PresenceAccount | null;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open || !account) return;
    setUrl(account.url);
    setFormError(null);
  }, [open, account]);

  async function submit() {
    if (!account) return;
    setSaving(true);
    setFormError(null);
    try {
      await updatePresenceAccount(projectId, account.id, url.trim());
      onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct account URL</DialogTitle>
          <DialogDescription>
            Use this when the crawler stored the wrong link — a share URL, a post, or a similarly
            named account.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Your URL is still here." />
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="dp-correct-url">Profile URL (required)</Label>
          <Input
            id="dp-correct-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            inputMode="url"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || url.trim() === ''}>
            {saving ? 'Saving…' : 'Save URL'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Only http(s) and app-relative targets become links (§10.5). */
function AccountLink({ url }: { url: string }) {
  const isSafe = url.startsWith('/') || /^https?:\/\//i.test(url);
  if (!isSafe) {
    return <span className="evidence">{url} (not a link: unsupported URL scheme)</span>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all text-primary underline-offset-4 hover:underline"
    >
      <ExternalLink aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
      {url}
    </a>
  );
}

function presenceStateTone(state: string): StatusTone {
  switch (state) {
    case 'confirmed':
      return 'success';
    // Unverified is the honest and common outcome for walled platforms — a
    // missing observation, not a failure.
    case 'unverified':
      return 'unmeasured';
    case 'missing':
      return 'unmeasured';
    case 'candidate':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function presenceStateLabel(state: string): string {
  switch (state) {
    case 'confirmed':
      return 'Confirmed';
    case 'unverified':
      return 'Found, unverified';
    case 'missing':
      return 'No account found';
    case 'candidate':
      return 'Candidate';
    default:
      return `Unrecognized: ${state}`;
  }
}

function presenceEntityLabel(entity: string): string {
  switch (entity) {
    case 'company':
      return 'Company';
    case 'personal':
      return 'A person, not the company';
    case 'unknown':
      return 'Not established — could be either';
    default:
      return `Unrecognized: ${entity}`;
  }
}

function consistencyTone(status: string): StatusTone {
  switch (status) {
    case 'match':
      return 'success';
    case 'mismatch':
      return 'warning';
    default:
      return 'unmeasured';
  }
}

function consistencyLabel(status: string): string {
  switch (status) {
    case 'match':
      return 'Name matches';
    case 'mismatch':
      return 'Name differs';
    case 'not-checked':
      return 'Not checked';
    default:
      return `Unrecognized: ${status}`;
  }
}

function footprintStateLabel(state: string): string {
  switch (state) {
    case 'found':
      return 'Found';
    case 'none':
      return 'None found';
    case 'not-checked':
      return 'No module has looked';
    default:
      return `Unrecognized: ${state}`;
  }
}

function footprintStateTone(state: string): StatusTone {
  switch (state) {
    case 'found':
      return 'success';
    case 'none':
      return 'neutral';
    default:
      // A question nobody has asked is not a negative answer.
      return 'unmeasured';
  }
}

function discoveryTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'crawling':
    case 'verifying':
      return 'info';
    default:
      return 'unmeasured';
  }
}

function capabilityStateLabel(state: string): string {
  switch (state) {
    case 'not-built':
      return 'Not built';
    case 'not-configured':
      return 'Not configured';
    case 'not-run':
      return 'Not run yet';
    default:
      return `Unrecognized: ${state}`;
  }
}
