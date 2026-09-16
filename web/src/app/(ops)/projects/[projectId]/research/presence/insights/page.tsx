'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  buildBrandVoice,
  getBrandVoice,
  getPresenceInventory,
  getResearchScope,
  pullBusinessProfile,
  pullDirectoryRatings,
  runSocialActivity,
  type BrandVoiceRead,
  type BusinessProfileSnapshot,
  type PresenceInventory,
  type ResearchScope,
  type ReviewSnapshot,
  type SocialActivitySummary,
} from '@/services/research-library';

/**
 * DP02 — Presence insights.
 *
 * design_plan.md §4.3: *"Social activity, business profile/reviews, directory
 * ratings, brand-voice source excerpts"* and §5.6's analysis half of stage 2:
 * *"DataForSEO snapshot and public directory AggregateRating reads"*, with the
 * warning that follows: *"A data pull is not a connection."*
 *
 * Three distinctions this page refuses to blur:
 *
 *  1. **A pull is a read, not a connection, and nothing here publishes.** Every
 *     action on this screen fetches public data about the client or reads a
 *     rating a listing already publishes. None of them grants publishing
 *     access, and none of them posts anything — the page says so at each entry
 *     point rather than relying on the reader to infer it.
 *  2. **Paid vendor data and free page reads are labelled apart.** A review
 *     snapshot's `source` is `dataforseo` (a paid Business Data call) or
 *     `schema-scrape` (the `AggregateRating` the listing publishes about
 *     itself). They are different kinds of evidence and are counted separately.
 *  3. **Ratings only. No sentiment is invented over review text.** The backend
 *     stores a rating and a review count and nothing else, and this screen
 *     renders exactly that.
 */
/** Stable reference: `useUrlState` decodes against it on every render. */
const TAB_DEFAULTS = { tab: 'social' };

const APIFY_PLATFORMS = ['linkedin', 'instagram', 'facebook', 'twitter', 'youtube', 'tiktok'] as const;

export default function PresenceInsightsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [inventory, setInventory] = useState<PresenceInventory | null>(null);
  const [brandVoice, setBrandVoice] = useState<BrandVoiceRead | null>(null);
  /** True only for a 404 from the brand-voice route — "none built yet". */
  const [brandVoiceNotBuilt, setBrandVoiceNotBuilt] = useState(false);
  const [brandVoiceError, setBrandVoiceError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [tabState, setTabState] = useUrlState(TAB_DEFAULTS);
  const tab = tabState.tab;

  const [socialOpen, setSocialOpen] = useState(false);
  const [businessOpen, setBusinessOpen] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setBrandVoiceError(null);
        setBrandVoiceNotBuilt(false);
        const [inventoryResult, voiceResult] = await Promise.all([
          getPresenceInventory(projectId, { signal }),
          getBrandVoice(projectId, { signal })
            .then((value) => ({ ok: true as const, value }))
            .catch((caught: unknown) => {
              if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
              return { ok: false as const, cause: caught };
            }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setInventory(inventoryResult);
        if (voiceResult.ok) {
          setBrandVoice(voiceResult.value);
        } else {
          const apiError = toApiError(voiceResult.cause);
          // 404 here is the documented "none built yet", not a failure to hide.
          if (apiError.kind === 'not-found') {
            setBrandVoice(null);
            setBrandVoiceNotBuilt(true);
          } else {
            setBrandVoiceError(apiError);
          }
        }
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

  async function runAction(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Presence insights" />
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

  const vendorReviews = inventory.reviews.filter((review) => review.source === 'dataforseo');
  const scrapedReviews = inventory.reviews.filter((review) => review.source !== 'dataforseo');

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
          The project context could not be read, so the client name is not shown above.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Digital footprint', href: `/projects/${projectId}/research/presence` },
          { label: 'Presence insights' },
        ]}
        title="Presence insights"
        context="Public data read about the client's accounts — no connection is made and nothing is published"
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <Alert>
        <AlertTitle>These are reads, not connections</AlertTitle>
        <AlertDescription>
          Every action on this screen fetches public information or reads a rating a listing already
          publishes. None of them signs in as the client, none grants publishing access, and none of
          them sends anything to a platform. A pull being successful is not evidence that a
          connection exists.
        </AlertDescription>
      </Alert>

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTabState({ tab: value }, { push: true })}>
        <TabsList>
          <TabsTrigger value="social">Social activity</TabsTrigger>
          <TabsTrigger value="business">Business profile &amp; reviews</TabsTrigger>
          <TabsTrigger value="ratings">Directory ratings</TabsTrigger>
          <TabsTrigger value="voice">Brand voice</TabsTrigger>
        </TabsList>

        <TabsContent value="social" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Posting cadence and reach</CardTitle>
              <Button size="sm" onClick={() => setSocialOpen(true)}>
                Pull social activity
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                Read from public profile and post data via a third-party scraping service. It is a
                sample of recent posts, not a full history and not platform analytics — a sample
                size is shown next to every engagement figure so a mean over three posts cannot be
                mistaken for a monthly average.
              </p>
              <SocialActivityTable rows={inventory.socialActivity} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="business" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Google Business Profile</CardTitle>
              <Button size="sm" onClick={() => setBusinessOpen(true)}>
                Pull business profile
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              {!inventory.businessProfile ? (
                <EmptyState
                  variant="not-measured"
                  subject="Business profile and review ratings"
                  prerequisite="No business-profile pull has been made for this project. It reads the public Google Business Profile and the published counts for Google, Trustpilot and Yelp."
                  action={{ label: 'Pull business profile', onClick: () => setBusinessOpen(true) }}
                  layout="inline"
                />
              ) : (
                <BusinessProfileView profile={inventory.businessProfile} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Ratings by source</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-table font-medium">Paid vendor read</h3>
                  <ProvenanceBadge kind="measured" label="DataForSEO Business Data" />
                </div>
                <p className="text-meta text-muted-foreground">
                  Google, Trustpilot and Yelp only — the platforms that vendor covers. Each pull is a
                  new snapshot; a profile drifts over time, so snapshots are never overwritten.
                </p>
                <ReviewTable
                  rows={vendorReviews}
                  caption="Vendor-sourced review ratings"
                  emptyCopy="No vendor-sourced rating has been pulled yet."
                />
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-table font-medium">Published by the listing itself</h3>
                  <ProvenanceBadge kind="measured" label="AggregateRating read off the page" />
                </div>
                <p className="text-meta text-muted-foreground">
                  The rating each listing declares about itself in its own structured data. No vendor
                  and no per-lookup cost. A listing that loads but declares no rating writes nothing —
                  that is a fact about the listing, not a failed call.
                </p>
                <ReviewTable
                  rows={scrapedReviews}
                  caption="Listing-published review ratings"
                  emptyCopy="No listing-published rating has been read yet — use the directory ratings tab."
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ratings" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Read published directory ratings</CardTitle>
              <Button
                size="sm"
                onClick={() =>
                  void runAction('ratings', () => pullDirectoryRatings(projectId))
                }
                disabled={busy === 'ratings'}
              >
                {busy === 'ratings' ? 'Reading…' : 'Read ratings now'}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-table text-muted-foreground">
                For every G2, Capterra, Trustpilot, Glassdoor, Yelp, Clutch, Crunchbase or Product
                Hunt account already discovered, this reads the rating that listing publishes about
                itself. Unconfirmed candidates and personal profiles are excluded.
              </p>
              <p className="text-meta text-muted-foreground">
                Ratings and counts only. No sentiment is derived from review text, because none is
                read — a rating with no wording behind it cannot support a claim about what customers
                think.
              </p>
              <ReviewTable
                rows={inventory.reviews}
                caption="All stored review ratings"
                emptyCopy="No rating is stored. Run a read, or pull the business profile for the vendor-covered platforms."
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="voice" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Brand voice from stored captions</CardTitle>
              <Button
                size="sm"
                onClick={() => void runAction('voice', () => buildBrandVoice(projectId))}
                disabled={busy === 'voice'}
              >
                {busy === 'voice' ? 'Synthesizing…' : brandVoiceNotBuilt ? 'Build brand voice' : 'Rebuild brand voice'}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              {brandVoiceError ? (
                <ErrorState
                  error={brandVoiceError}
                  layout="inline"
                  onRetry={() => void load()}
                  preserveNotice="The rest of this page is unaffected."
                />
              ) : brandVoiceNotBuilt || !brandVoice ? (
                <EmptyState
                  variant="not-measured"
                  subject="Brand voice"
                  prerequisite="A brand-voice read is synthesized from captions already stored by a social-activity pull, and needs at least three captions plus a configured language model. Pull social activity first."
                  action={{
                    label: 'Pull social activity',
                    onClick: () => setSocialOpen(true),
                  }}
                  layout="inline"
                />
              ) : (
                <BrandVoiceView voice={brandVoice} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <SocialActivityDialog
        open={socialOpen}
        onOpenChange={setSocialOpen}
        projectId={projectId}
        onDone={() => {
          setSocialOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <BusinessProfileDialog
        open={businessOpen}
        onOpenChange={setBusinessOpen}
        projectId={projectId}
        defaultBusinessName={scope?.clientName ?? scope?.projectName ?? ''}
        onDone={() => {
          setBusinessOpen(false);
          void load();
        }}
        onError={setActionError}
      />
    </div>
  );
}

function SocialActivityTable({ rows }: { rows: SocialActivitySummary[] }) {
  const columns: ReadonlyArray<ColumnDef<SocialActivitySummary>> = [
    {
      key: 'platform',
      header: 'Platform',
      accessor: (row) => row.platform,
      sortable: true,
      width: 140,
      render: (row) => <span className="capitalize">{row.platform}</span>,
    },
    {
      key: 'followerCount',
      header: 'Followers',
      accessor: (row) => row.followerCount,
      sortable: true,
      align: 'right',
      width: 130,
      emptyLabel: 'Not reported',
      render: (row) =>
        row.followerCount === null ? null : (
          <span className="tabular-nums">{formatNumber(row.followerCount)}</span>
        ),
    },
    {
      key: 'postsSampled',
      header: 'Posts sampled',
      accessor: (row) => row.postsSampled,
      sortable: true,
      align: 'right',
      width: 140,
      render: (row) => (
        <span className="tabular-nums">{formatNumber(row.postsSampled)}</span>
      ),
    },
    {
      key: 'avgEngagement',
      header: 'Mean engagement per post',
      accessor: (row) => row.avgEngagement,
      sortable: true,
      align: 'right',
      width: 200,
      emptyLabel: 'No posts to average',
      render: (row) =>
        row.avgEngagement === null ? null : (
          <span className="tabular-nums">{formatNumber(Math.round(row.avgEngagement))}</span>
        ),
    },
    {
      key: 'lastPostAt',
      header: 'Most recent post',
      accessor: (row) => row.lastPostAt,
      sortable: true,
      width: 210,
      emptyLabel: 'No post date captured',
      render: (row) => (row.lastPostAt ? <Timestamp value={row.lastPostAt} /> : null),
    },
  ];

  return (
    <DataTable
      caption="Social activity by platform"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.platform}
      defaultSort={{ key: 'postsSampled', direction: 'desc' }}
      minTableWidth="58rem"
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Social activity"
          prerequisite="No social-activity pull has been made. It reads public profile and post data and spends third-party account credit, so it is never run automatically."
          layout="inline"
        />
      }
    />
  );
}

function BusinessProfileView({ profile }: { profile: BusinessProfileSnapshot }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="measured" label={`Source: ${profile.source}`} />
        <span className="text-meta text-muted-foreground">
          Snapshot <Timestamp value={profile.fetchedAt} />
        </span>
      </div>
      <dl className="grid gap-x-8 gap-y-2 text-table sm:grid-cols-2">
        <div>
          <dt className="text-meta text-muted-foreground">Listed name</dt>
          <dd>{profile.name ?? 'Not reported by the source'}</dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Categories</dt>
          <dd>{profile.categories.length ? profile.categories.join(', ') : 'None reported'}</dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Rating</dt>
          <dd className="tabular-nums">
            {profile.rating === null ? 'No rating published' : profile.rating}
            {profile.reviewCount !== null ? (
              <span className="ml-2 text-meta text-muted-foreground">
                over {formatNumber(profile.reviewCount)} review
                {profile.reviewCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Address</dt>
          <dd>{profile.address ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Phone</dt>
          <dd>{profile.phone ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt className="text-meta text-muted-foreground">Website</dt>
          <dd>
            {profile.website ? (
              <SafeLink href={profile.website} />
            ) : (
              <span className="text-muted-foreground">Not reported</span>
            )}
          </dd>
        </div>
      </dl>
      <p className="text-meta text-muted-foreground">
        Opening hours are stored exactly as the provider returned them and are not reshaped here —
        the raw provider shape is not a contract this screen can render faithfully.
      </p>
    </div>
  );
}

function ReviewTable({
  rows,
  caption,
  emptyCopy,
}: {
  rows: ReviewSnapshot[];
  caption: string;
  emptyCopy: string;
}) {
  const columns: ReadonlyArray<ColumnDef<ReviewSnapshot>> = [
    {
      key: 'platform',
      header: 'Platform',
      accessor: (row) => row.platform,
      sortable: true,
      width: 140,
      render: (row) => <span className="capitalize">{row.platform}</span>,
    },
    {
      key: 'rating',
      header: 'Rating',
      accessor: (row) => row.rating,
      sortable: true,
      align: 'right',
      width: 110,
      emptyLabel: 'No rating published',
      render: (row) =>
        row.rating === null ? null : <span className="tabular-nums">{row.rating}</span>,
    },
    {
      key: 'reviewCount',
      header: 'Reviews',
      accessor: (row) => row.reviewCount,
      sortable: true,
      align: 'right',
      width: 120,
      emptyLabel: 'Not published',
      render: (row) =>
        row.reviewCount === null ? null : (
          <span className="tabular-nums">{formatNumber(row.reviewCount)}</span>
        ),
    },
    {
      key: 'source',
      header: 'Read from',
      accessor: (row) => row.source,
      sortable: true,
      width: 180,
      render: (row) => (
        <ProvenanceBadge
          kind="measured"
          label={row.source === 'dataforseo' ? 'Paid vendor' : 'Listing’s own markup'}
        />
      ),
    },
    {
      key: 'fetchedAt',
      header: 'Captured',
      accessor: (row) => row.fetchedAt,
      sortable: true,
      width: 200,
      render: (row) => <Timestamp value={row.fetchedAt} />,
    },
    {
      key: 'url',
      header: 'Listing',
      accessor: (row) => row.url,
      emptyLabel: 'No listing URL',
      render: (row) => (row.url ? <SafeLink href={row.url} /> : null),
    },
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      defaultSort={{ key: 'platform', direction: 'asc' }}
      minTableWidth="60rem"
      emptyMessage={emptyCopy}
    />
  );
}

function BrandVoiceView({ voice }: { voice: BrandVoiceRead }) {
  const insufficient = voice.extraction === 'insufficient-data';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="model-interpretation" label="Synthesized from stored captions" />
        <span className="text-meta text-muted-foreground">
          Read built <Timestamp value={voice.createdAt} /> ·{' '}
          <span className="tabular-nums">{voice.postSample}</span> caption
          {voice.postSample === 1 ? '' : 's'} read
          {voice.llmModel ? ` · model ${voice.llmModel}` : ''}
        </span>
      </div>

      {insufficient ? (
        <Alert>
          <AlertTitle>Not enough captions to read a voice from</AlertTitle>
          <AlertDescription>
            The synthesis needs at least three stored captions and a configured language model.
            Rather than guessing from too little, the read reports insufficient data. Pull social
            activity for more accounts, then rebuild.
          </AlertDescription>
        </Alert>
      ) : null}

      {voice.summary ? (
        <div>
          <h3 className="text-meta font-medium text-foreground">Summary</h3>
          {/* Model output, rendered as escaped text — never as markup (§10.5). */}
          <p className="evidence mt-1">{voice.summary}</p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <TermList title="Tone" values={voice.tone} />
        <TermList title="Recurring themes" values={voice.themes} />
        <TermList title="Vocabulary" values={voice.vocabulary} />
        <TermList title="Call-to-action patterns" values={voice.callToActions} />
      </div>

      {voice.byPlatform.length > 0 ? (
        <div>
          <h3 className="text-meta font-medium text-foreground">Per platform</h3>
          <ul className="mt-1 space-y-2">
            {voice.byPlatform.map((entry) => (
              <li key={entry.platform} className="rounded-lg border border-border p-3 text-table">
                <p className="font-medium capitalize">
                  {entry.platform}{' '}
                  <span className="text-meta font-normal text-muted-foreground">
                    from {entry.postSample} caption{entry.postSample === 1 ? '' : 's'}
                  </span>
                </p>
                <p className="mt-1 text-meta text-muted-foreground">
                  Tone: {entry.tone.length ? entry.tone.join(', ') : 'nothing recurring found'}
                </p>
                <p className="text-meta text-muted-foreground">
                  Themes: {entry.themes.length ? entry.themes.join(', ') : 'nothing recurring found'}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-meta text-muted-foreground">
        Every term above is extracted from captions already stored by a social-activity pull — the
        captions are the source, and this read restates them. If the sample is thin, the read says
        so rather than extrapolating.
      </p>
    </div>
  );
}

function TermList({ title, values }: { title: string; values: string[] }) {
  return (
    <div>
      <h3 className="text-meta font-medium text-foreground">{title}</h3>
      {values.length === 0 ? (
        <p className="mt-1 text-meta text-muted-foreground">
          Nothing recurring was found for this in the sample.
        </p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="rounded-md border border-border-strong bg-surface-sunken px-2 py-0.5 text-meta"
            >
              {value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SocialActivityDialog({
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
  const [confirmSpend, setConfirmSpend] = useState(false);
  const [platforms, setPlatforms] = useState<string[]>(['linkedin', 'instagram', 'facebook', 'twitter']);
  const [postsPerPlatform, setPostsPerPlatform] = useState('20');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  function togglePlatform(platform: string, checked: boolean) {
    setPlatforms((current) =>
      checked ? [...current, platform] : current.filter((value) => value !== platform),
    );
  }

  async function submit() {
    setRunning(true);
    setFormError(null);
    try {
      const posts = Number(postsPerPlatform);
      await runSocialActivity(projectId, {
        confirmSpend: true,
        platforms,
        postsPerPlatform: Number.isFinite(posts) && posts > 0 ? posts : undefined,
      });
      setConfirmSpend(false);
      onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setRunning(false);
    }
  }

  const canRun = confirmSpend && platforms.length > 0;

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
          <DialogTitle>Pull social activity</DialogTitle>
          <DialogDescription>
            Runs third-party scraping actors against this project&rsquo;s linked accounts for posting
            cadence, followers and engagement. It reads public data only — it does not sign in as the
            client and does not publish anything.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            providerName="the scraping provider"
            preserveNotice="Nothing was pulled."
          />
        ) : null}

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div>
            <Label htmlFor="dp2-confirm-spend">I understand this spends account credit</Label>
            <p className="mt-1 text-meta text-muted-foreground">
              Required. This call runs real scraping actors against a paid third-party account; there
              is no default path that reaches it, so the run only happens on an explicit yes.
            </p>
          </div>
          <Switch id="dp2-confirm-spend" checked={confirmSpend} onCheckedChange={setConfirmSpend} />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-table font-medium">Platforms</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {APIFY_PLATFORMS.map((platform) => (
              <div key={platform} className="flex items-center gap-2">
                <Checkbox
                  id={`dp2-platform-${platform}`}
                  checked={platforms.includes(platform)}
                  onCheckedChange={(checked) => togglePlatform(platform, checked === true)}
                />
                <Label htmlFor={`dp2-platform-${platform}`} className="capitalize">
                  {platform}
                </Label>
              </div>
            ))}
          </div>
          <p className="text-meta text-muted-foreground">
            Required: at least one platform. Each one adds to the run cost.
          </p>
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="dp2-posts">Recent posts per platform</Label>
          <Input
            id="dp2-posts"
            type="number"
            min={1}
            max={100}
            value={postsPerPlatform}
            onChange={(event) => setPostsPerPlatform(event.target.value)}
          />
          <p className="text-meta text-muted-foreground">
            Between 1 and 100. More posts cost more and give a steadier engagement mean.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={running || !canRun}>
            {running ? 'Pulling…' : 'Pull social activity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BusinessProfileDialog({
  open,
  onOpenChange,
  projectId,
  defaultBusinessName,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  defaultBusinessName: string;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [businessName, setBusinessName] = useState('');
  const [locationName, setLocationName] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusinessName(defaultBusinessName);
    setLocationName('');
    setFormError(null);
  }, [open, defaultBusinessName]);

  async function submit() {
    setRunning(true);
    setFormError(null);
    try {
      await pullBusinessProfile(projectId, {
        businessName: businessName.trim() || undefined,
        locationName: locationName.trim() || undefined,
      });
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
          <DialogTitle>Pull business profile</DialogTitle>
          <DialogDescription>
            Reads the public Google Business Profile and the published review counts for Google,
            Trustpilot and Yelp. It stores a new snapshot each time — a business profile drifts, so
            older snapshots are kept rather than overwritten.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            providerName="DataForSEO Business Data"
            preserveNotice="No profile was stored."
          />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="dp2-business-name">Business name</Label>
            <Input
              id="dp2-business-name"
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              maxLength={200}
              placeholder="Defaults to the project's client name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dp2-location">Location</Label>
            <Input
              id="dp2-location"
              value={locationName}
              onChange={(event) => setLocationName(event.target.value)}
              maxLength={200}
              placeholder="e.g. London,England,United Kingdom"
            />
            <p className="text-meta text-muted-foreground">
              Searched by name and location. Without a location the provider&rsquo;s single generic
              fallback is used, which is a place to start rather than a resolved market.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={running}>
            {running ? 'Pulling…' : 'Pull profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SafeLink({ href }: { href: string }) {
  const isSafe = href.startsWith('/') || /^https?:\/\//i.test(href);
  if (!isSafe) {
    return <span className="evidence">{href} (not a link: unsupported URL scheme)</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all text-primary underline-offset-4 hover:underline"
    >
      <ExternalLink aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
      {href}
    </a>
  );
}
