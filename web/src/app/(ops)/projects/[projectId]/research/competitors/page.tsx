'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
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
import {
  confirmCompetitorCandidate,
  discoverCompetitors,
  discoverCompetitorsByMarket,
  getCompetitorGap,
  getNamedCompetitors,
  getResearchScope,
  listCompetitorCandidates,
  listCompetitorProfiles,
  reclassifyCompetitorCandidate,
  rejectCompetitorCandidate,
  setNamedCompetitors,
  type CompetitorRecord,
  type CompetitorWithProfile,
  type DiscoverByMarketResult,
  type GapResult,
  type NamedCompetitor,
  type NamedCompetitorList,
  type ResearchScope,
  type SerpDiscoveredDomain,
} from '@/services/research-library';

/**
 * CO01 — Competitors.
 *
 * design_plan.md §4.3: *"Named benchmark list, profiles, candidate review,
 * gaps, SERP discoveries"*; the competitive-comparison family adds *"named list
 * editor, discovery actions, per-competitor profile cards, gap findings; no
 * invented overall competitor score"*.
 *
 * Four things this page keeps separate, all from §1.5 and G14:
 *
 *  1. **A named competitor, a profiled competitor and a candidate are three
 *     different things.** The named list is the exact set share-of-voice
 *     benchmarks against; a profile row is what was observed about one of them;
 *     a candidate is a name nothing has confirmed. They are three panels, not
 *     one list with a status column.
 *  2. **A SERP-discovered domain is a candidate, not a competitor.** Something
 *     outranking the client on a tracked keyword may be a directory, a
 *     marketplace or a news site. It carries `discovered-candidate` provenance
 *     until a person adds it.
 *  3. **Share of voice is an AI-answer measurement, not a ranking.** It is
 *     shown under its own heading and never averaged with the gap diff or
 *     anything from SERP tracking.
 *  4. **The gap is a diff, not a score.** The endpoint returns presence diffs
 *     over tech, schema and platforms; the page reports which side has
 *     something the other does not, and derives no composite from it.
 *
 * Replacing the named list is genuinely load-bearing: share-of-voice counts
 * only names on it, so an empty list means no benchmark is produced at all.
 * That is why the editor confirms with a typed phrase rather than a button.
 */
/**
 * §12.1 unifies this screen into three views: Tracked competitors, Suggested
 * competitors, Comparison. "Tracked" merges the named benchmark list with its
 * built profiles (one row is one competitor, whether or not it has been
 * profiled yet). "Suggested" merges AI-answer candidates, SERP-discovered
 * domains, and §12.2 service/market-discovery candidates into one review
 * queue, since all three are the same kind of thing: an unconfirmed proposal
 * needing a human decision, never a difference in navigation destination.
 */
const TAB_DEFAULTS = { tab: 'tracked' };

export default function CompetitorsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [named, setNamed] = useState<NamedCompetitorList | null>(null);
  const [profiles, setProfiles] = useState<CompetitorWithProfile[] | null>(null);
  const [candidates, setCandidates] = useState<CompetitorRecord[] | null>(null);
  const [gap, setGap] = useState<GapResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [tabState, setTabState] = useUrlState(TAB_DEFAULTS);
  const tab = tabState.tab;

  const [editOpen, setEditOpen] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<SerpDiscoveredDomain | null>(null);
  const [pendingReject, setPendingReject] = useState<CompetitorRecord | null>(null);
  const [marketResult, setMarketResult] = useState<DiscoverByMarketResult | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [namedResult, profilesResult, candidatesResult, gapResult] = await Promise.all([
          getNamedCompetitors(projectId, { signal }),
          listCompetitorProfiles(projectId, { signal }),
          listCompetitorCandidates(projectId, { signal }),
          getCompetitorGap(projectId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setNamed(namedResult);
        setProfiles(profilesResult);
        setCandidates(candidatesResult);
        setGap(gapResult);
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

  async function handleDiscover() {
    setBusy('discover');
    setActionError(null);
    try {
      await discoverCompetitors(projectId, {});
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirm(profile: CompetitorRecord) {
    setActionError(null);
    try {
      await confirmCompetitorCandidate(projectId, profile.id);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  async function handleReject(profile: CompetitorRecord) {
    setActionError(null);
    try {
      await rejectCompetitorCandidate(projectId, profile.id, 'Rejected by operator');
      setPendingReject(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  async function handleReclassify(candidate: CompetitorRecord, relevance: 'direct-competitor' | 'adjacent-alternative' | 'not-relevant') {
    setActionError(null);
    try {
      await reclassifyCompetitorCandidate(projectId, candidate.id, relevance);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  /**
   * §12.2/§12.3 — two distinct actions, never conflated: `collectNew: false`
   * (the default "Find suggestions") only mines already-stored AEO/SERP
   * evidence, free, no vendor call. `collectNew: true` ("Collect new
   * results") additionally runs a small bounded set of Google searches
   * through the gated, budgeted SERP provider — explicit, never automatic.
   */
  async function handleMarketDiscover(collectNew: boolean) {
    setBusy(collectNew ? 'collect' : 'suggest');
    setActionError(null);
    setMarketResult(null);
    try {
      const result = await discoverCompetitorsByMarket(projectId, { collectNew });
      setMarketResult(result);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleAddDiscovered(domain: SerpDiscoveredDomain) {
    if (!named) return;
    setActionError(null);
    try {
      await setNamedCompetitors(projectId, [
        ...named.tracked,
        { name: domain.domain, domain: domain.domain, source: 'manual' },
      ]);
      setPendingAdd(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Competitors" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!named || !profiles || !candidates || !gap) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
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
          domain: gap.domain,
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
          { label: 'Competitors' },
        ]}
        title="Competitors"
        context={
          <>
            {named.tracked.length} named benchmark{pluralS(named.tracked.length)} ·{' '}
            {profiles.length} profiled · {candidates.length} candidate
            {candidates.length === 1 ? '' : 's'} awaiting a decision
          </>
        }
        primaryAction={{
          label: busy === 'discover' ? 'Discovering…' : 'Build profiles',
          onClick: () => void handleDiscover(),
          disabled: busy === 'discover',
          disabledReason:
            'A discovery run is already in flight — it fans out to one homepage fetch per competitor.',
        }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={`/projects/${projectId}/research/competitors/compare`}>Compare side by side</a>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit named list
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      <Alert>
        <AlertTitle>What &ldquo;build profiles&rdquo; actually does</AlertTitle>
        <AlertDescription>
          It promotes the named list into tracked rows and makes one homepage fetch per competitor —
          a tech-stack scan and a JSON-LD read — then attaches whatever SERP and AEO results already
          exist. It never runs a full technical audit per competitor and never triggers a new SERP
          or AI-visibility run. Rate limited to five runs a minute.
        </AlertDescription>
      </Alert>

      <Tabs value={tab} onValueChange={(value) => setTabState({ tab: value }, { push: true })}>
        <TabsList>
          <TabsTrigger value="tracked">Tracked competitors ({named.tracked.length})</TabsTrigger>
          <TabsTrigger value="suggested">
            Suggested competitors ({candidates.length + named.discovered.length})
          </TabsTrigger>
          <TabsTrigger value="comparison">Comparison</TabsTrigger>
        </TabsList>

        <TabsContent value="tracked" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Named benchmark list</CardTitle>
              <Button size="sm" onClick={() => setEditOpen(true)}>
                Edit list
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                This is the exact set every share-of-voice measurement benchmarks against. Names here
                are the ones counted in answers; a name that is not on this list is not benchmarked,
                and an empty list means no benchmark is produced at all.
              </p>
              <NamedListTable tracked={named.tracked} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                AI-answer share of voice (counted, not ranked)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <p className="text-meta text-muted-foreground">
                These figures count what was said in AI answers that were actually collected. They
                are not search positions and are not combined with anything on the SERP screens —
                design_plan §1.5 keeps counted AI-answer rates and search ranks apart.
              </p>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    label: 'Named benchmarks on file',
                    value: String(named.readiness.rivals),
                    note: 'A count of names, not a benchmark-coverage figure.',
                  },
                  {
                    label: 'AI-visibility runs attached',
                    value: String(named.readiness.runs),
                    note: 'The runs whose answers the figures below are counted over.',
                  },
                  {
                    label: 'Observations counted',
                    value: String(named.readiness.observations),
                    note: 'Few observations mean a thin basis — no significance is claimed from them.',
                  },
                  {
                    label: 'Answers naming the client',
                    value: `${named.you.mentioned} of ${named.you.total}`,
                    note: 'Counted over collected answers, not over search results.',
                  },
                ].map((tile) => (
                  <div key={tile.label} className="rounded-lg border border-border p-3">
                    <dt className="text-meta text-muted-foreground">{tile.label}</dt>
                    <dd className="mt-1 text-kpi tabular-nums text-foreground">{tile.value}</dd>
                    <p className="mt-1 text-meta text-muted-foreground">{tile.note}</p>
                  </div>
                ))}
              </dl>

              {named.rivals.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="Share of voice"
                  prerequisite="It needs a completed AI-visibility run benchmarked against the named list above."
                  layout="inline"
                />
              ) : (
                <ul className="space-y-2">
                  {named.rivals.map((rival) => (
                    <li
                      key={rival.name}
                      className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border p-3 text-table"
                    >
                      <span className="font-medium">{rival.name}</span>
                      <span className="text-meta text-muted-foreground">
                        appeared in <span className="tabular-nums">{rival.appearances}</span> answers
                        · share <span className="tabular-nums">{formatNumber(rival.share)}%</span> ·
                        ahead of the client in{' '}
                        <span className="tabular-nums">{rival.beatYou}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {named.losing.length > 0 ? (
                <div>
                  <h3 className="text-meta font-medium text-foreground">
                    Prompts where a named rival appeared and the client did not
                  </h3>
                  <ul className="mt-1 space-y-1 text-meta text-muted-foreground">
                    {named.losing.map((entry) => (
                      <li key={`${entry.surface}-${entry.prompt}`}>
                        <span className="evidence">{entry.prompt}</span> on{' '}
                        {entry.surface} — {entry.rivals.join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tracked" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Profiled competitors</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                One homepage fetch per competitor, plus whatever already exists. Homepage-only is a
                real limit: a content inventory would need each rival&rsquo;s sitemap crawled, which
                this does not do. Warnings in the profile column name what could not be read for
                that rival and do not blank the rest.
              </p>
              <ProfileTable profiles={profiles} projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="suggested" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Find more competitors</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                Composed from confirmed services and target markets, combined with rival
                names/domains already seen in stored AI-visibility and SERP evidence.
                Partners/directories/publishing platforms and the client&rsquo;s own domain are
                excluded before a row is ever created, and the existing tracked list is never
                replaced — this only proposes additions.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleMarketDiscover(false)}
                  disabled={busy !== null}
                >
                  {busy === 'suggest' ? 'Finding suggestions…' : 'Find suggestions (free)'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleMarketDiscover(true)}
                  disabled={busy !== null}
                >
                  {busy === 'collect' ? 'Collecting…' : 'Collect new results (bounded search, budgeted)'}
                </Button>
              </div>
              <p className="text-meta text-muted-foreground">
                &ldquo;Find suggestions&rdquo; only reads what is already stored — no vendor call, safe
                to run any time. &ldquo;Collect new results&rdquo; additionally runs a small bounded set
                of Google searches through the gated SERP provider — an explicit, budgeted action,
                never triggered automatically.
              </p>
              {marketResult ? (
                <Alert>
                  <AlertTitle>
                    {marketResult.candidatesProposed} new candidate{marketResult.candidatesProposed === 1 ? '' : 's'}{' '}
                    proposed
                    {marketResult.collectNew ? ` (${marketResult.queriesRun} bounded search(es) run, $${marketResult.costUsd.toFixed(4)})` : ' (from stored evidence only)'}
                  </AlertTitle>
                  <AlertDescription>
                    {marketResult.candidatesExcluded} candidate{marketResult.candidatesExcluded === 1 ? '' : 's'} excluded
                    (own domain, directories/platforms, or previously rejected).
                    {marketResult.exclusionSample.length > 0 ? (
                      <ul className="mt-1 list-disc space-y-0.5 pl-5">
                        {marketResult.exclusionSample.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                Candidates awaiting review
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                Names an AI surface mentioned, or names/domains proposed by service/market
                discovery above, that are not already recorded. They are never profiled, never
                appear in the comparison, and never enter the tracked list until a person confirms
                one — a proposal is a hypothesis, not a competitive claim.
              </p>
              <CandidateTable
                candidates={candidates}
                onConfirm={handleConfirm}
                onReject={setPendingReject}
                onReclassify={handleReclassify}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                Domains out-ranking the client on tracked keywords
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                Derived from first-page organic domains already stored on SERP results — no extra
                fetching and no spend. A domain here is a <strong>candidate</strong>: it may be a
                directory, a marketplace or a news site rather than a rival. Adding one writes it
                into the named benchmark list above, which is what share-of-voice then reads.
              </p>
              <DiscoveredTable discovered={named.discovered} onAdd={setPendingAdd} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="comparison" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Presence diff</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProvenanceBadge kind="derived" label="A diff, not a score" />
                <span className="text-meta text-muted-foreground">
                  Generated <Timestamp value={gap.generatedAt} />
                </span>
              </div>
              <p className="text-table text-muted-foreground">{gap.note}</p>

              <GapDiffPanel
                title="Technology"
                client={gap.tech.client}
                competitorsOnly={gap.tech.competitorsOnly}
                clientOnly={gap.tech.clientOnly}
                shared={gap.tech.shared}
              />
              <GapDiffPanel
                title="Structured data (schema types)"
                client={gap.schema.client}
                competitorsOnly={gap.schema.competitorsOnly}
                clientOnly={gap.schema.clientOnly}
                shared={gap.schema.shared}
              />
              <GapDiffPanel
                title="External presence platforms"
                client={gap.presence.client}
                competitorsOnly={gap.presence.competitorsOnly}
                clientOnly={gap.presence.clientOnly}
                shared={gap.presence.shared}
              />

              <p className="text-meta text-muted-foreground">{gap.seo.note}</p>
              <p className="text-meta text-muted-foreground">{gap.reviews.note}</p>

              <Button variant="outline" size="sm" asChild>
                <a href={`/projects/${projectId}/research/competitors/compare`}>
                  Open the side-by-side comparison
                </a>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <NamedListDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={projectId}
        tracked={named.tracked}
        discovered={named.discovered}
        onSaved={() => {
          setEditOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <ConfirmDialog
        open={pendingAdd !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAdd(null);
        }}
        title="Add to the named benchmark list"
        confirmLabel="Add to benchmark list"
        targetLabel="Domain"
        target={pendingAdd?.domain ?? ''}
        effect={
          <>
            The domain is appended to the named benchmark list. From the next measurement on, share
            of voice is counted against it as well — including any answers already stored, when a
            later run re-reads them.
          </>
        }
        scope={
          <>
            The rest of the list is preserved: this sends the existing{' '}
            {named.tracked.length} name{pluralS(named.tracked.length)} plus this one. The API replaces
            the list, so the send is the whole list, not just the addition.
          </>
        }
        onConfirm={async () => {
          if (pendingAdd) await handleAddDiscovered(pendingAdd);
        }}
        onReload={() => void load()}
      />

      <ConfirmDialog
        open={pendingReject !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReject(null);
        }}
        title="Reject candidate"
        confirmLabel="Reject candidate"
        destructive
        targetLabel="Candidate"
        target={pendingReject?.name ?? ''}
        effect={
          <>
            The candidate is deleted. This discards a name an AI surface mentioned — it does not
            touch any tracked competitor.
          </>
        }
        scope={<>Only this project&rsquo;s candidate list is affected.</>}
        onConfirm={async () => {
          if (pendingReject) await handleReject(pendingReject);
        }}
        onReload={() => void load()}
      />
    </div>
  );
}

function NamedListTable({ tracked }: { tracked: NamedCompetitor[] }) {
  const columns: ReadonlyArray<ColumnDef<NamedCompetitor>> = [
    {
      key: 'name',
      header: 'Name',
      accessor: (row) => row.name,
      sortable: true,
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: 'domain',
      header: 'Domain',
      accessor: (row) => row.domain,
      sortable: true,
      emptyLabel: 'No domain on record',
    },
    {
      key: 'source',
      header: 'How it got here',
      accessor: (row) => row.source ?? 'unrecorded',
      sortable: true,
      width: 240,
      render: (row) => (
        <ProvenanceBadge
          kind={row.source === 'aeo-answer' ? 'discovered-candidate' : 'operator-supplied'}
          label={namedSourceLabel(row.source)}
        />
      ),
    },
  ];

  return (
    <DataTable
      caption="Named benchmark competitors"
      columns={columns}
      rows={tracked}
      getRowId={(row) => row.name}
      defaultSort={{ key: 'name', direction: 'asc' }}
      minTableWidth="52rem"
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="The named benchmark list"
          prerequisite="Share-of-voice measurement benchmarks against exactly these names. Add at least one — or confirm a candidate — before running an AI-visibility measurement."
          layout="inline"
        />
      }
    />
  );
}

function ProfileTable({
  profiles,
  projectId,
}: {
  profiles: CompetitorWithProfile[];
  projectId: string;
}) {
  const columns: ReadonlyArray<ColumnDef<CompetitorWithProfile>> = [
    {
      key: 'name',
      header: 'Competitor',
      accessor: (row) => row.name,
      sortable: true,
      render: (row) => (
        <span className="font-medium">
          {row.name}
          {row.domain ? (
            <span className="ml-2 text-meta font-normal text-muted-foreground">{row.domain}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'tech',
      header: 'Tech stack',
      accessor: (row) => row.latestProfile?.techScanId ?? null,
      width: 150,
      emptyLabel: 'No profile built',
      render: (row) =>
        row.latestProfile ? (
          <StatusPill
            label={profileStatusLabel(row.latestProfile.status)}
            tone={profileStatusTone(row.latestProfile.status)}
          />
        ) : null,
    },
    {
      key: 'schema',
      header: 'Schema types',
      accessor: (row) => row.latestProfile?.schemaTypes.length ?? null,
      sortable: true,
      align: 'right',
      width: 150,
      emptyLabel: 'Not read',
      render: (row) => {
        const types = row.latestProfile?.schemaTypes;
        if (!types) return null;
        return (
          <span className="text-meta" title={types.join(', ')}>
            {types.length === 0 ? 'none found' : types.slice(0, 3).join(', ')}
            {types.length > 3 ? ` +${types.length - 3}` : ''}
          </span>
        );
      },
    },
    {
      key: 'aeo',
      header: 'AI answers',
      accessor: (row) => row.latestProfile?.aeoStatus ?? null,
      width: 170,
      emptyLabel: 'No profile built',
      render: (row) =>
        row.latestProfile ? (
          <StatusPill
            label={attachStatusLabel(row.latestProfile.aeoStatus, 'answers')}
            tone={attachStatusTone(row.latestProfile.aeoStatus)}
          />
        ) : null,
    },
    {
      key: 'serp',
      header: 'SERP presence',
      accessor: (row) => row.latestProfile?.serpStatus ?? null,
      width: 170,
      emptyLabel: 'No profile built',
      render: (row) =>
        row.latestProfile ? (
          <StatusPill
            label={attachStatusLabel(row.latestProfile.serpStatus, 'trackers')}
            tone={attachStatusTone(row.latestProfile.serpStatus)}
          />
        ) : null,
    },
    {
      key: 'presence',
      header: 'External profiles',
      accessor: (row) => row.latestProfile?.presenceAccounts.length ?? null,
      sortable: true,
      align: 'right',
      width: 170,
      emptyLabel: 'Not crawled',
      render: (row) => {
        const profile = row.latestProfile;
        if (!profile) return null;
        if (profile.presenceStatus !== 'completed') {
          return (
            <span className="text-meta text-unmeasured-foreground">
              {profile.presenceError ?? attachStatusLabel(profile.presenceStatus, 'profiles')}
            </span>
          );
        }
        return (
          <span className="tabular-nums">{profile.presenceAccounts.length}</span>
        );
      },
    },
    {
      key: 'seo',
      header: 'Homepage score',
      accessor: (row) => row.latestProfile?.seoScore ?? null,
      sortable: true,
      align: 'right',
      width: 170,
      emptyLabel: 'Not scored',
      render: (row) => {
        const score = row.latestProfile?.seoScore;
        if (score === null || score === undefined) return null;
        return (
          <span className="tabular-nums" title="Homepage only, on the client's own rubric">
            {score}
          </span>
        );
      },
    },
    {
      key: 'open',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: () => (
        <a
          href={`/projects/${projectId}/research/competitors/compare`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Compare
        </a>
      ),
    },
  ];

  return (
    <DataTable
      caption="Profiled competitors"
      columns={columns}
      rows={profiles}
      getRowId={(row) => row.id}
      defaultSort={{ key: 'name', direction: 'asc' }}
      minTableWidth="80rem"
      searchable
      rowDetail={(row) => <ProfileDetail profile={row} />}
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Competitor profiles"
          prerequisite="No tracked competitor has a profile yet. Add names to the benchmark list, then build profiles — one homepage fetch per competitor."
        />
      }
    />
  );
}

function ProfileDetail({ profile }: { profile: CompetitorWithProfile }) {
  const latest = profile.latestProfile;
  if (!latest) {
    return (
      <p className="text-table text-muted-foreground">
        No profile has been built for this competitor, so nothing has been observed about it yet.
      </p>
    );
  }
  return (
    <div className="space-y-2 text-table">
      <p className="text-meta text-muted-foreground">
        Profiled <Timestamp value={latest.createdAt} />
        {latest.domain ? ` · homepage ${latest.domain}` : ' · no domain on record'}
      </p>
      {latest.error ? (
        <p className="text-meta">
          <span className="text-muted-foreground">Profile error:</span>{' '}
          <span className="evidence">{latest.error}</span>
        </p>
      ) : null}
      {latest.seoError ? (
        <p className="text-meta">
          <span className="text-muted-foreground">SEO read error:</span>{' '}
          <span className="evidence">{latest.seoError}</span>
        </p>
      ) : null}
      {latest.reviewError ? (
        <p className="text-meta">
          <span className="text-muted-foreground">Review read error:</span>{' '}
          <span className="evidence">{latest.reviewError}</span>
        </p>
      ) : null}
      {latest.seoIssues.length > 0 ? (
        <p className="text-meta">
          <span className="text-muted-foreground">Homepage issues:</span>{' '}
          {latest.seoIssues.join(', ')}
        </p>
      ) : null}
      {latest.reviewRatings.length > 0 ? (
        <div>
          <h4 className="text-meta font-medium text-foreground">Published ratings</h4>
          <ul className="mt-1 space-y-0.5 text-meta text-muted-foreground">
            {latest.reviewRatings.map((rating) => (
              <li key={rating.platform}>
                {rating.label}: {rating.found ? `${rating.rating ?? '—'} (${rating.ratingCount ?? 0} reviews)` : 'no rating published'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-meta text-muted-foreground">
        Homepage only. A content inventory would need this rival&rsquo;s sitemap crawled, which this
        does not do — so no article counts or publishing cadence are claimed here.
      </p>
    </div>
  );
}

function CandidateTable({
  candidates,
  onConfirm,
  onReject,
  onReclassify,
}: {
  candidates: CompetitorRecord[];
  onConfirm: (candidate: CompetitorRecord) => void;
  onReject: (candidate: CompetitorRecord) => void;
  onReclassify: (candidate: CompetitorRecord, relevance: 'direct-competitor' | 'adjacent-alternative' | 'not-relevant') => void;
}) {
  const columns: ReadonlyArray<ColumnDef<CompetitorRecord>> = [
    {
      key: 'name',
      header: 'Candidate name',
      accessor: (row) => row.name,
      sortable: true,
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: 'source',
      header: 'Provenance',
      accessor: (row) => row.source,
      width: 220,
      render: (row) => (
        <ProvenanceBadge kind="discovered-candidate" label={candidateSourceLabel(row.source)} />
      ),
    },
    {
      key: 'relevance',
      header: 'Relevance',
      accessor: (row) => row.relevance ?? 'direct-competitor',
      width: 200,
      render: (row) => (
        <select
          className="rounded-md border border-border bg-background px-2 py-1 text-meta"
          value={row.relevance ?? 'direct-competitor'}
          onChange={(event) =>
            onReclassify(row, event.target.value as 'direct-competitor' | 'adjacent-alternative' | 'not-relevant')
          }
        >
          <option value="direct-competitor">Direct competitor</option>
          <option value="adjacent-alternative">Adjacent alternative</option>
          <option value="not-relevant">Not relevant</option>
        </select>
      ),
    },
    {
      key: 'domain',
      header: 'Domain',
      accessor: (row) => row.domain,
      emptyLabel: 'No domain resolved',
    },
    {
      key: 'createdAt',
      header: 'First seen',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'actions',
      header: '',
      width: 240,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onConfirm(row)}>
            Confirm as competitor
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onReject(row)}>
            Reject
          </Button>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      caption="Unconfirmed competitor candidates"
      columns={columns}
      rows={candidates}
      getRowId={(row) => row.id}
      minTableWidth="64rem"
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Competitor candidates"
          prerequisite="No AI answer has named a company that is not already recorded as a competitor."
          layout="inline"
        />
      }
    />
  );
}

function DiscoveredTable({
  discovered,
  onAdd,
}: {
  discovered: SerpDiscoveredDomain[];
  onAdd: (domain: SerpDiscoveredDomain) => void;
}) {
  const columns: ReadonlyArray<ColumnDef<SerpDiscoveredDomain>> = [
    {
      key: 'domain',
      header: 'Domain',
      accessor: (row) => row.domain,
      sortable: true,
      render: (row) => <span className="font-medium">{row.domain}</span>,
    },
    {
      key: 'appearances',
      header: 'Keywords it ranked on',
      accessor: (row) => row.appearances,
      sortable: true,
      align: 'right',
      width: 190,
      render: (row) => <span className="tabular-nums">{row.appearances}</span>,
    },
    {
      key: 'bestRank',
      header: 'Best position seen',
      accessor: (row) => row.bestRank,
      sortable: true,
      align: 'right',
      width: 180,
      emptyLabel: 'No position recorded',
      render: (row) =>
        row.bestRank === null ? null : <span className="tabular-nums">{row.bestRank}</span>,
    },
    {
      key: 'keyword',
      header: 'Sample keyword',
      accessor: (row) => row.keyword,
      emptyLabel: 'No sample keyword stored',
    },
    {
      key: 'provenance',
      header: 'Provenance',
      accessor: () => 'serp',
      width: 220,
      render: () => (
        <ProvenanceBadge kind="discovered-candidate" label="From stored SERP results" />
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 190,
      alwaysVisible: true,
      render: (row) => (
        <Button size="sm" variant="outline" onClick={() => onAdd(row)}>
          Add to benchmark list
        </Button>
      ),
    },
  ];

  return (
    <>
      <p className="text-meta text-muted-foreground">
        Positions shown here are search positions from SERP tracking. They are a different
        measurement from the AI-answer share-of-voice figures on the benchmark tab and are not
        combined with them.
      </p>
      <DataTable
        caption="Domains discovered from stored SERP results"
        columns={columns}
        rows={discovered}
        getRowId={(row) => row.domain}
        defaultSort={{ key: 'appearances', direction: 'desc' }}
        minTableWidth="72rem"
        emptyState={
          <EmptyState
            variant="not-measured"
            subject="SERP-discovered domains"
            prerequisite="This reads first-page organic domains already stored on SERP results. No SERP tracker has captured anything for this project yet."
            layout="inline"
          />
        }
      />
    </>
  );
}

function GapDiffPanel({
  title,
  client,
  competitorsOnly,
  clientOnly,
  shared,
}: {
  title: string;
  client: string[];
  competitorsOnly: Array<{ key: string; competitors: string[] }>;
  clientOnly: Array<{ key: string }>;
  shared: Array<{ key: string }>;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <h3 className="text-table font-medium">{title}</h3>
      <p className="mt-1 text-meta text-muted-foreground">
        Client has <span className="tabular-nums">{client.length}</span> · beyond every rival{' '}
        <span className="tabular-nums">{clientOnly.length}</span> · rivals have and the client does
        not <span className="tabular-nums">{competitorsOnly.length}</span> · shared{' '}
        <span className="tabular-nums">{shared.length}</span>
      </p>
      {competitorsOnly.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-meta font-medium text-foreground">
            Rivals have it, the client does not
          </h4>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta">
            {competitorsOnly.map((line) => (
              <li key={line.key}>
                {line.key}
                <span className="text-muted-foreground"> — {line.competitors.join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-meta text-muted-foreground">
          Nothing here is held by a rival and missing from the client.
        </p>
      )}
      {clientOnly.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-meta font-medium text-foreground">Client has it, no rival does</h4>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta">
            {clientOnly.map((line) => (
              <li key={line.key}>{line.key}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function NamedListDialog({
  open,
  onOpenChange,
  projectId,
  tracked,
  discovered,
  onSaved,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  tracked: NamedCompetitor[];
  discovered: SerpDiscoveredDomain[];
  onSaved: () => void;
  onError: (error: ApiError) => void;
}) {
  const [rows, setRows] = useState<Array<{ name: string; domain: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(tracked.map((entry) => ({ name: entry.name, domain: entry.domain ?? '' })));
    setFormError(null);
  }, [open, tracked]);

  const cleaned = rows
    .map((row) => ({ name: row.name.trim(), domain: row.domain.trim() }))
    .filter((row) => row.name !== '');
  const duplicateNames = new Set(
    cleaned.map((row) => row.name.toLowerCase()).filter((name, index, all) => all.indexOf(name) !== index),
  );
  const canSave = duplicateNames.size === 0;

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      await setNamedCompetitors(
        projectId,
        cleaned.map((row) => ({
          name: row.name,
          domain: row.domain || null,
          source: 'manual',
        })),
      );
      setConfirmOpen(false);
      onSaved();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (saving) return;
          setFormError(null);
          onOpenChange(next);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit the named benchmark list</DialogTitle>
            <DialogDescription>
              The list is replaced as a whole when saved. Names not on it are not benchmarked, and an
              empty list means no share-of-voice benchmark is produced.
            </DialogDescription>
          </DialogHeader>

          {formError ? (
            <ErrorState
              error={formError}
              layout="inline"
              preserveNotice="The list on the server is unchanged; your edits are still here."
            />
          ) : null}

          <div className="space-y-3">
            <div className="space-y-2">
              {rows.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  No names entered. Saving now would clear the benchmark list.
                </p>
              ) : null}
              {rows.map((row, index) => (
                <div key={index} className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`nc-name-${index}`}>Name (required)</Label>
                    <Input
                      id={`nc-name-${index}`}
                      value={row.name}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, name: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`nc-domain-${index}`}>Domain</Label>
                    <Input
                      id={`nc-domain-${index}`}
                      value={row.domain}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, domain: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="example.com"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    aria-label={`Remove ${row.name || 'this row'}`}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setRows((current) => [...current, { name: '', domain: '' }])}>
                <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
                Add a row
              </Button>
              {discovered.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRows((current) => [
                      ...current,
                      ...discovered.map((entry) => ({ name: entry.domain, domain: entry.domain })),
                    ])
                  }
                >
                  Add all {discovered.length} SERP-discovered domains
                </Button>
              ) : null}
            </div>

            {duplicateNames.size > 0 ? (
              <p className="text-meta text-warning-foreground">
                Two rows share a name ({[...duplicateNames].join(', ')}). The server keeps one row per
                name, so remove a duplicate before saving.
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={saving || !canSave || (rows.length > 0 && cleaned.length === 0)}
            >
              Review and save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Replace the named competitor list"
        confirmLabel="Replace competitor list"
        destructive
        confirmPhrase="REPLACE LIST"
        targetLabel="Resulting list"
        target={`${cleaned.length} name${pluralS(cleaned.length)}`}
        effect={
          <>
            The list on the server is replaced with the {cleaned.length} name
            {pluralS(cleaned.length)} above. Names removed here stop being benchmarked, and because
            share-of-voice counts only names on the list, removing all of them means no benchmark is
            produced at all.
          </>
        }
        scope={
          <>
            Competitor rows that were promoted from previous names are not deleted — they keep their
            profiles, and the comparison screen still shows them. Only the benchmark list changes.
          </>
        }
        onConfirm={save}
        onReload={onSaved}
      >
        <ul className="max-h-48 space-y-0.5 overflow-auto text-meta">
          {cleaned.map((row) => (
            <li key={row.name}>
              {row.name}
              {row.domain ? <span className="text-muted-foreground"> — {row.domain}</span> : null}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}

/** Plural suffix: `1 competitor` / `2 competitors`. */
function pluralS(count: number): string {
  return count === 1 ? '' : 's';
}

function candidateSourceLabel(source: string): string {
  switch (source) {
    case 'aeo-answer':
      return 'Named by an AI surface';
    case 'market-discovery':
      return 'Service/market discovery';
    case 'manual':
      return 'Entered by an operator';
    default:
      return source;
  }
}

function namedSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'project-json':
      return 'On the project record';
    case 'manual':
      return 'Entered by an operator';
    case 'aeo-answer':
      return 'Confirmed from an AI answer';
    default:
      return source ? `Source not recognized: ${source}` : 'Source not recorded';
  }
}

function profileStatusTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'warning';
    case 'skipped':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}

function profileStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Scanned';
    case 'failed':
      return 'Scan failed';
    case 'skipped':
      return 'No domain to scan';
    default:
      return `Unrecognized: ${status}`;
  }
}

function attachStatusTone(status: string): StatusTone {
  switch (status) {
    case 'present':
      return 'success';
    case 'absent':
      return 'neutral';
    // "unknown" means nothing has run at all — not "no presence".
    default:
      return 'unmeasured';
  }
}

function attachStatusLabel(status: string, noun: string): string {
  switch (status) {
    case 'present':
      return 'Attached';
    case 'absent':
      return `No ${noun} to attach`;
    case 'unknown':
      return 'Not measured yet';
    default:
      return `Unrecognized: ${status}`;
  }
}
