'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CalendarDays, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { GenerationDialog, type GenerationEntry } from '@/components/content/GenerationDialog';
import { GenerationStatus } from '@/components/content/GenerationStatus';
import { useUrlState } from '@/hooks/useUrlState';
import { CONTENT_ASSET_TYPES, listContentBriefs, type ContentAssetType, type ContentBrief } from '@/services/content';
import { listTeamMembers, type TeamMember } from '@/services/delivery-plan';
import {
  CLIENT_REVIEW_STATE_LABELS,
  CONTENT_VIEWS,
  CONTENT_VIEW_LABELS,
  EDITORIAL_STATE_LABELS,
  PUBLICATION_STATE_LABELS,
  UPDATE_STATE_LABELS,
  generationImplementedFor,
  listContentCapabilities,
  listContentWorkspace,
  type ContentCapability,
  type ContentView,
  type ContentWorkspaceItem,
} from '@/services/content-workspace';
import {
  OPPORTUNITY_ORIGIN_LABELS,
  convertOpportunityToContent,
  listOpportunities,
  newIdempotencyKey,
  type Opportunity,
} from '@/services/opportunities';

/**
 * P08 — the Content workspace (§13.1–13.3, §13.9).
 *
 * §13.1's rule shapes this whole screen: an idea, a content plan, a draft and a
 * published piece are **different stages of work**, and "consolidation means
 * showing their relationship clearly, not pretending the objects are
 * interchangeable or concatenating all backend lists into duplicate rows".
 * So there is exactly one content table, and Ideas are a different tab backed
 * by a different record — never merged into the same list as a lookalike row.
 *
 * Three further decisions worth stating, because the obvious version of this
 * page gets each of them wrong:
 *
 *  1. **The badge never replaces the axes (§13.4).** `primaryBadge` is the
 *     scannable label, and the four axes are rendered underneath it on every
 *     row. "Published · Update in progress" therefore keeps showing that the
 *     live piece is still live, rather than collapsing to "Draft".
 *  2. **Placements expand under a piece (§13.3).** They are the piece's
 *     `rowDetail`, so the "All content" count stays a count of *pieces*: a
 *     piece with three placements is one row, not four.
 *  3. **Filters and counts are the server's (§13.3).** Every control below is
 *     passed to `/content-workspace/items`, which applies the same predicate
 *     to the page and to `total`. Nothing here filters a fetched page, so the
 *     "showing X of Y" line can never describe a different set than the rows.
 */

const FILTER_DEFAULTS = {
  view: 'all',
  q: '',
  assetType: 'all',
  stage: 'all',
  source: 'all',
  language: 'all',
  market: 'all',
  owner: 'all',
  visibility: 'all',
  page: '1',
};

const PAGE_SIZE = 25;

const SOURCE_OPTIONS = [
  { value: 'opportunity', label: 'From an idea' },
  { value: 'gap', label: 'From a keyword gap' },
  { value: 'manual', label: 'Created directly' },
];

const STAGE_OPTIONS = (Object.keys(EDITORIAL_STATE_LABELS) as Array<keyof typeof EDITORIAL_STATE_LABELS>).map(
  (state) => ({ value: state, label: EDITORIAL_STATE_LABELS[state] }),
);

const VISIBILITY_OPTIONS = [
  { value: 'shared', label: 'Shared with the client' },
  { value: 'not-shared', label: 'Not shared' },
];

export default function ContentWorkspacePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [items, setItems] = useState<ContentWorkspaceItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [capabilities, setCapabilities] = useState<ContentCapability[] | undefined>(undefined);
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [teamRefused, setTeamRefused] = useState(false);
  const [ideas, setIdeas] = useState<Opportunity[] | null>(null);
  const [ideaError, setIdeaError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [dialogEntry, setDialogEntry] = useState<GenerationEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [jobRefreshKey, setJobRefreshKey] = useState(0);
  const [plans, setPlans] = useState<ContentBrief[] | null>(null);

  const view = filters.view as ContentView;
  const isIdeas = view === 'ideas';

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await listContentWorkspace(
          projectId,
          {
            view,
            q: filters.q || undefined,
            assetType: filters.assetType === 'all' ? undefined : filters.assetType,
            editorialState: filters.stage === 'all' ? undefined : filters.stage,
            source: filters.source === 'all' ? undefined : filters.source,
            language: filters.language === 'all' ? undefined : filters.language,
            market: filters.market === 'all' ? undefined : filters.market,
            assigneeId: filters.owner === 'all' ? undefined : filters.owner,
            clientVisibility:
              filters.visibility === 'all'
                ? undefined
                : (filters.visibility as 'shared' | 'not-shared'),
            page: Number(filters.page) || 1,
            pageSize: PAGE_SIZE,
          },
          { signal },
        );
        setItems(result.items);
        setTotal(result.total);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, view, filters],
  );

  const loadIdeas = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setIdeaError(null);
        const result = await listOpportunities(
          projectId,
          { page: Number(filters.page) || 1, pageSize: PAGE_SIZE, search: filters.q || undefined },
          { signal },
        );
        setIdeas(result.opportunities);
        setTotal(result.total);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setIdeaError(toApiError(caught));
      }
    },
    [projectId, filters.page, filters.q],
  );

  // The §13.9 matrix is loaded once per project: it is what decides whether a
  // Generate control may exist at all.
  useEffect(() => {
    const controller = new AbortController();
    void listContentCapabilities(projectId, { signal: controller.signal })
      .then(setCapabilities)
      .catch(() => setCapabilities([]));
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void listTeamMembers({ signal: controller.signal })
      .then((members) => {
        setTeam(members);
        setTeamRefused(false);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        // §10.2: "you may not see the people" and "there are no people" are
        // different facts, and only one of them can be true here.
        setTeamRefused(true);
        setTeam(null);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (isIdeas) void loadIdeas(controller.signal);
    else void load(controller.signal);
    return () => controller.abort();
  }, [isIdeas, load, loadIdeas]);

  const ownerName = useCallback(
    (assigneeId: string | null) => {
      if (!assigneeId) return null;
      return team?.find((member) => member.id === assigneeId)?.name ?? null;
    },
    [team],
  );

  // §13.6's third entry point: prepare a draft from an approved content plan.
  // The plans are read here rather than in a screen of their own, because a
  // plan exists to be drafted from — it is a step, not a destination (§13.1).
  useEffect(() => {
    const controller = new AbortController();
    void listContentBriefs(
      projectId,
      { status: 'approved', latestOnly: true },
      { signal: controller.signal },
    )
      .then((result) => setPlans(result.briefs))
      .catch(() => setPlans([]));
    return () => controller.abort();
  }, [projectId, jobRefreshKey]);

  /**
   * §13.6's second entry point: "Start from an idea".
   *
   * The promotion itself is the opportunities module's own idempotent
   * conversion — it runs inside the dialog, which is where the plan and style
   * are chosen, so a confirm here cannot create the piece twice. Doing the
   * conversion first and *then* asking what to generate would leave a piece
   * behind for every idea someone opened the dialog on and cancelled.
   */
  const promote = useCallback(
    (opportunity: Opportunity) => {
      setDialogEntry({
        kind: 'idea',
        opportunityId: opportunity.id,
        topic: opportunity.topicDisplay,
        reason: opportunity.reason,
      });
      setDialogOpen(true);
    },
    [],
  );

  /**
   * The same promotion without generation, for an idea whose type has no
   * tested writer. Creating the piece is a real capability; pretending to
   * generate it is not (§13.9), so this button says what it does.
   */
  const createPieceOnly = useCallback(
    async (opportunity: Opportunity) => {
      setPromoting(opportunity.id);
      try {
        const result = await convertOpportunityToContent(projectId, opportunity.id, {
          idempotencyKey: newIdempotencyKey(),
          assetType: asContentAssetType(opportunity.suggestedContentType) ?? undefined,
        });
        await loadIdeas();
        setIdeas((current) =>
          (current ?? []).map((row) =>
            row.id === opportunity.id
              ? { ...row, status: 'converted', linkedGrowthAssetId: result.asset.id }
              : row,
          ),
        );
      } catch (caught) {
        setIdeaError(toApiError(caught));
      } finally {
        setPromoting(null);
      }
    },
    [projectId, loadIdeas],
  );

  const columns = useMemo<ReadonlyArray<ColumnDef<ContentWorkspaceItem>>>(
    () => [
      {
        key: 'title',
        header: 'Content',
        accessor: (row) => row.title,
        sortable: true,
        width: 300,
        render: (row) => (
          <div className="min-w-0 space-y-1">
            <Link
              href={`/projects/${projectId}/content/${row.assetId}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {row.title}
            </Link>
            <p className="text-meta text-muted-foreground">
              {SOURCE_LABELS[row.source] ?? row.source}
              {row.promotedFromOpportunityId ? (
                <>
                  {' · '}
                  <Link
                    href={`/projects/${projectId}/content/opportunities/${row.promotedFromOpportunityId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    from an idea
                  </Link>
                </>
              ) : null}
            </p>
          </div>
        ),
      },
      {
        key: 'badge',
        header: 'State',
        accessor: (row) => row.primaryBadge,
        sortable: true,
        width: 240,
        render: (row) => (
          <div className="space-y-1">
            {/* §13.4 — the derived badge, with every underlying axis still on
                the row. A reader must be able to see that a Published piece
                also has a revision in progress, not just the summary. */}
            <StatusPill label={row.primaryBadge} tone={badgeTone(row)} />
            <ul className="space-y-0.5 text-meta text-muted-foreground">
              <li>Editorial: {EDITORIAL_STATE_LABELS[row.editorialState]}</li>
              <li>Client: {CLIENT_REVIEW_STATE_LABELS[row.clientReviewState]}</li>
              <li>
                Publication: {PUBLICATION_STATE_LABELS[row.publicationSummary.status]}
                {row.publicationSummary.placements.length > 0
                  ? ` (${row.publicationSummary.placements.length} placement${
                      row.publicationSummary.placements.length === 1 ? '' : 's'
                    })`
                  : ''}
              </li>
              <li>Update: {UPDATE_STATE_LABELS[row.updateState]}</li>
            </ul>
          </div>
        ),
      },
      {
        key: 'assetType',
        header: 'Type',
        accessor: (row) => row.assetType,
        sortable: true,
        width: 150,
        render: (row) => (
          <div className="space-y-1">
            <span className="text-table text-foreground">
              {capabilities?.find((capability) => capability.assetType === row.assetType)?.label ??
                row.assetType}
            </span>
            <p className="text-meta text-muted-foreground">
              v{row.currentVersion}
              {row.language ? ` · ${row.language}` : ''}
            </p>
          </div>
        ),
      },
      {
        key: 'owner',
        header: 'Owner',
        accessor: (row) => ownerName(row.assigneeId) ?? row.assigneeId ?? '',
        sortable: true,
        width: 160,
        render: (row) => (
          <span className="text-table text-muted-foreground">
            {ownerName(row.assigneeId) ?? (row.assigneeId ? 'Assigned' : 'Unassigned')}
          </span>
        ),
      },
      {
        key: 'next',
        header: 'Next',
        accessor: (row) => nextPlacementDate(row) ?? row.updatedAt,
        sortable: true,
        width: 200,
        render: (row) => {
          const next = nextPlacementDate(row);
          return (
            <div className="space-y-1">
              <p className="text-table text-foreground">{row.nextAction}</p>
              <p className="text-meta text-muted-foreground">
                {next ? (
                  <>
                    <CalendarDays aria-hidden="true" className="mr-1 inline h-3 w-3" />
                    <Timestamp value={next} dateOnly />
                  </>
                ) : (
                  'No date set'
                )}
              </p>
            </div>
          );
        },
      },
      {
        key: 'updatedAt',
        header: 'Updated',
        accessor: (row) => row.updatedAt,
        sortable: true,
        width: 160,
        render: (row) => <Timestamp value={row.updatedAt} />,
      },
    ],
    [projectId, capabilities, ownerName],
  );

  const ideaColumns = useMemo<ReadonlyArray<ColumnDef<Opportunity>>>(
    () => [
      {
        key: 'topic',
        header: 'Idea',
        accessor: (row) => row.topicDisplay,
        sortable: true,
        width: 260,
        render: (row) => (
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-foreground">{row.topicDisplay}</p>
            <p className="text-meta text-muted-foreground">
              {OPPORTUNITY_ORIGIN_LABELS[row.origin]}
              {row.market ? ` · ${row.market}` : ''}
              {row.language ? ` · ${row.language}` : ''}
            </p>
          </div>
        ),
      },
      {
        key: 'reason',
        header: 'Why it is worth doing',
        accessor: (row) => row.reason,
        width: 300,
        render: (row) => (
          <div className="space-y-1">
            <p className="text-table text-foreground">{row.reason}</p>
            <p className="text-meta text-muted-foreground">
              {row.evidence.length > 0
                ? `Evidence: ${row.evidence
                    .slice(0, 2)
                    .map((entry) => entry.query ?? entry.note)
                    .filter(Boolean)
                    .join('; ')}`
                : 'No evidence attached'}
            </p>
          </div>
        ),
      },
      {
        key: 'relevance',
        header: 'Demand',
        accessor: (row) => row.relevance,
        sortable: true,
        width: 150,
        render: (row) => (
          <div className="space-y-1 text-table">
            <p>{row.relevance}/100 relevance</p>
            <p className="text-meta text-muted-foreground">
              {row.demandVolume !== null ? `${row.demandVolume} searches` : 'Volume not measured'}
            </p>
          </div>
        ),
      },
      {
        key: 'action',
        header: 'Next step',
        width: 220,
        render: (row) => {
          if (row.status === 'converted' && row.linkedGrowthAssetId) {
            // §13.3 — a promoted idea links to its piece; it does not sit
            // beside the draft as a second, unexplained recommendation.
            return (
              <Link
                href={`/projects/${projectId}/content/${row.linkedGrowthAssetId}`}
                className="inline-flex items-center gap-1 text-table text-primary underline-offset-4 hover:underline"
              >
                Open the piece
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
              </Link>
            );
          }
          if (row.status === 'dismissed') {
            return (
              <span className="text-meta text-muted-foreground">
                Dismissed{row.dismissedReason ? `: ${row.dismissedReason}` : ''}
              </span>
            );
          }
          const generatable = capabilities?.find(
            (capability) => capability.assetType === (row.suggestedContentType ?? 'article'),
          )?.generationImplemented;
          // §13.9 — the capability matrix decides which action exists. A type
          // with no tested writer gets the real capability it does have
          // (creating the piece), never a Generate button that would fail
          // after the click.
          if (generatable !== true) {
            return (
              <div className="space-y-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void createPieceOnly(row)}
                  disabled={promoting === row.id}
                >
                  {promoting === row.id ? 'Creating…' : 'Create the piece'}
                </Button>
                <p className="text-meta text-muted-foreground">
                  No tested writer for this type — it will be planned and written by hand.
                </p>
              </div>
            );
          }
          return (
            <Button variant="outline" size="sm" onClick={() => promote(row)}>
              <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
              Start content
            </Button>
          );
        },
      },
    ],
    [projectId, capabilities, promoting, promote, createPieceOnly],
  );

  const filtersActive =
    filters.q !== '' ||
    filters.assetType !== 'all' ||
    filters.stage !== 'all' ||
    filters.source !== 'all' ||
    filters.language !== 'all' ||
    filters.market !== 'all' ||
    filters.owner !== 'all' ||
    filters.visibility !== 'all';

  const ownerOptions = useMemo(() => {
    if (teamRefused) {
      // Names are unavailable, but the filter still works — it is by id.
      return [{ value: 'any-assigned', label: 'Names unavailable for your role' }].slice(0, 0);
    }
    return (team ?? []).map((member) => ({ value: member.id, label: member.name }));
  }, [team, teamRefused]);

  // Only offered when this project actually records markets — an always-present
  // filter that can only ever return nothing would read as "no content" (§13.3).
  const marketOptions = useMemo(() => {
    const markets = new Set<string>();
    for (const item of items ?? []) if (item.market) markets.add(item.market);
    return [...markets].map((market) => ({ value: market, label: market }));
  }, [items]);
  const languageOptions = useMemo(() => {
    const languages = new Set<string>();
    for (const item of items ?? []) if (item.language) languages.add(item.language);
    return [...languages].map((language) => ({ value: language, label: language }));
  }, [items]);

  const primaryAction = useMemo(
    () => ({
      label: 'New content',
      onClick: () => {
        setDialogEntry({ kind: 'new' });
        setDialogOpen(true);
      },
      // §13.9: no Generate affordance exists when no type has a writer, so the
      // action says what will actually happen instead of opening a dead dialog.
      disabled: capabilities !== undefined && !capabilities.some((c) => c.generationImplemented),
      disabledReason:
        'No content type has a tested writer in this build. Content can still be planned and written by hand.',
    }),
    [capabilities],
  );

  if (error && !isIdeas) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  const loading = isIdeas ? ideas === null && !ideaError : items === null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content"
        context={contextLine({ isIdeas, total, items })}
        primaryAction={primaryAction}
        secondaryActions={
          <div className="flex items-center gap-2">
            {/* §13.1 — writing style is a secondary destination, reachable from
                the Content header as well as from the navigation. */}
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content/writing-style`}>Writing style</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content/opportunities`}>Opportunities</Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (isIdeas) void loadIdeas();
                else void load();
              }}
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      <Tabs
        value={view}
        onValueChange={(next) => setFilters({ view: next, page: '1' })}
        className="space-y-4"
      >
        <TabsList className="flex-wrap">
          {CONTENT_VIEWS.map((candidate) => (
            <TabsTrigger key={candidate} value={candidate}>
              {CONTENT_VIEW_LABELS[candidate]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* §13.7 — the inline status re-reads the server's job ledger, so work in
          progress survives a reload and is never restarted by one. */}
      <GenerationStatus projectId={projectId} refreshKey={jobRefreshKey} />

      {/* §13.6's third entry point. Only approved plans are offered, because a
          draft prepared from an unapproved plan would be exactly the bypass the
          plan gate exists to prevent. */}
      {!isIdeas && plans && plans.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Prepare a draft from an approved plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {plans.slice(0, 5).map((plan) => (
              <div
                key={plan.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-table text-foreground">
                    {plan.title} · v{plan.version}
                  </p>
                  <p className="text-meta text-muted-foreground">
                    {plan.targetQuery ? `${plan.targetQuery} · ` : ''}
                    {plan.wordTarget ? `${plan.wordTarget} words · ` : ''}
                    approved {plan.approvedAt ? <Timestamp value={plan.approvedAt} dateOnly /> : null}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={generationImplementedFor(capabilities, plan.assetType) !== true}
                  title={
                    generationImplementedFor(capabilities, plan.assetType) === true
                      ? undefined
                      : 'No tested writer exists for this type. Open the plan and write it by hand.'
                  }
                  onClick={() => {
                    setDialogEntry({
                      kind: 'plan',
                      briefId: plan.id,
                      briefVersion: plan.version,
                      assetType: plan.assetType,
                      topic: plan.targetQuery ?? plan.title,
                    });
                    setDialogOpen(true);
                  }}
                >
                  <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
                  Prepare draft
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        hideSearch={false}
        searchLabel={isIdeas ? 'Search ideas' : 'Search content'}
        controls={[
          {
            kind: 'select',
            key: 'assetType',
            label: 'Type',
            options: (capabilities ?? []).flatMap((capability) =>
              capability.countsAsContent
                ? [{ value: capability.assetType, label: capability.label }]
                : [],
            ),
          },
          { kind: 'select', key: 'stage', label: 'Stage', options: STAGE_OPTIONS },
          { kind: 'select', key: 'source', label: 'Source', options: SOURCE_OPTIONS },
          ...(languageOptions.length > 1
            ? [{ kind: 'select' as const, key: 'language', label: 'Language', options: languageOptions }]
            : []),
          ...(marketOptions.length > 0
            ? [{ kind: 'select' as const, key: 'market', label: 'Market', options: marketOptions }]
            : []),
          ...(ownerOptions.length > 0
            ? [{ kind: 'select' as const, key: 'owner', label: 'Owner', options: ownerOptions }]
            : []),
          { kind: 'select', key: 'visibility', label: 'Client visibility', options: VISIBILITY_OPTIONS },
        ]}
        summary={`Showing ${(isIdeas ? ideas?.length : items?.length) ?? 0} of ${total}`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">
            {isIdeas ? 'Ideas' : CONTENT_VIEW_LABELS[view]}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {loading ? (
            <Skeleton className="h-72 rounded-xl" />
          ) : isIdeas ? (
            ideaError ? (
              <ErrorState error={ideaError} onRetry={() => void loadIdeas()} />
            ) : (
              <DataTable
                caption="Ideas"
                columns={ideaColumns}
                rows={ideas ?? []}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'relevance', direction: 'desc' }}
                minTableWidth="68rem"
                pagination={{
                  page: Number(filters.page) || 1,
                  pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
                  totalRows: total,
                  onPageChange: (page) => setFilters({ page: String(page) }),
                }}
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="content ideas"
                    prerequisite="run the gap analysis on the content opportunities screen"
                    action={{
                      label: 'Open content opportunities',
                      href: `/projects/${projectId}/content/opportunities`,
                    }}
                  >
                    An idea is a recommendation with its evidence, not a draft. Promoting one
                    creates the piece and links it back here.
                  </EmptyState>
                }
              />
            )
          ) : (
            <DataTable
              caption="Content"
              columns={columns}
              rows={items ?? []}
              getRowId={(row) => row.assetId}
              defaultSort={{ key: 'updatedAt', direction: 'desc' }}
              minTableWidth="76rem"
              pagination={{
                page: Number(filters.page) || 1,
                pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
                totalRows: total,
                onPageChange: (page) => setFilters({ page: String(page) }),
              }}
              rowDetail={(row) => <Placements item={row} />}
              emptyState={
                filtersActive ? (
                  <EmptyState variant="no-results" onClearFilters={() => setFilters(FILTER_DEFAULTS)} />
                ) : (
                  <EmptyState
                    variant="not-measured"
                    subject="content"
                    prerequisite="create a piece here, or promote an idea from the Ideas view"
                    action={
                      capabilities?.some((capability) => capability.generationImplemented)
                        ? { label: 'New content', onClick: () => { setDialogEntry({ kind: 'new' }); setDialogOpen(true); } }
                        : { label: 'Open content opportunities', href: `/projects/${projectId}/content/opportunities` }
                    }
                  >
                    Each piece appears once here. Its placements — the scheduled and published
                    destinations — expand underneath it rather than adding rows.
                  </EmptyState>
                )
              }
            />
          )}
        </CardContent>
      </Card>

      <GenerationDialog
        projectId={projectId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={dialogEntry}
        capabilities={capabilities}
        onAccepted={() => {
          setJobRefreshKey((key) => key + 1);
          void load();
          // An accepted job from the Ideas view has just promoted its idea, so
          // that row now has a piece to link to (§13.3).
          if (isIdeas) void loadIdeas();
        }}
      />
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  opportunity: 'From an idea',
  gap: 'From a keyword gap',
  manual: 'Created directly',
};

/** The idea's suggested type, but only when it names a type the workspace tracks. */
function asContentAssetType(value: string | null): ContentAssetType | null {
  if (!value) return null;
  return (CONTENT_ASSET_TYPES as readonly string[]).includes(value)
    ? (value as ContentAssetType)
    : null;
}

/** The earliest future-or-recent scheduled placement date on a piece, if any. */
function nextPlacementDate(item: ContentWorkspaceItem): string | null {
  const dates = item.publicationSummary.placements
    .map((placement) => placement.scheduledFor)
    .filter((value): value is string => !!value)
    .sort();
  return dates[0] ?? null;
}

function contextLine({
  isIdeas,
  total,
  items,
}: {
  isIdeas: boolean;
  total: number;
  items: ContentWorkspaceItem[] | null;
}): string {
  if (isIdeas) {
    return total === 0
      ? 'No ideas are waiting. Ideas arrive from the gap analysis.'
      : `${total} idea${total === 1 ? '' : 's'} waiting to be promoted, dismissed, or linked to the piece they became.`;
  }
  const placements = (items ?? []).reduce(
    (sum, item) => sum + item.publicationSummary.placements.length,
    0,
  );
  if (total === 0) return 'No content matches this view yet.';
  // Placements are named as placement *counts*, never added to the piece
  // count — one piece with two placements is one piece (§13.3).
  return `${total} piece${total === 1 ? '' : 's'}${
    placements > 0 ? ` · ${placements} placement${placements === 1 ? '' : 's'} on this page` : ''
  }`;
}

function badgeTone(item: ContentWorkspaceItem): StatusTone {
  if (item.publicationSummary.status === 'published') return 'success';
  if (item.publicationSummary.status === 'failed') return 'danger';
  if (item.publicationSummary.status === 'publishing') return 'info';
  if (item.publicationSummary.status === 'scheduled') return 'info';
  if (item.clientReviewState === 'changes-requested') return 'warning';
  if (item.editorialState === 'changes-requested') return 'warning';
  if (item.editorialState === 'approved' || item.clientReviewState === 'approved') return 'success';
  if (item.editorialState === 'planned') return 'neutral';
  return 'unmeasured';
}

/**
 * §13.3 — placements expand under the piece. The piece keeps one row, and
 * nothing here is counted into the list's total.
 */
function Placements({ item }: { item: ContentWorkspaceItem }) {
  const { placements } = item.publicationSummary;
  if (placements.length === 0) {
    return (
      <p className="text-meta text-muted-foreground">
        No placement yet. A placement is a destination this piece is scheduled or published to —
        publishing happens only from an approved revision.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-meta text-muted-foreground">
        {placements.length} placement{placements.length === 1 ? '' : 's'} — part of this one piece,
        not additional content.
      </p>
      <ul className="divide-y divide-border">
        {placements.map((placement) => (
          <li key={placement.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="text-table text-foreground">
                {placement.provider || 'Destination'} · {placement.mode}
              </p>
              <p className="text-meta text-muted-foreground">
                Revision {placement.revisionNumber ?? '—'}
                {placement.scheduledFor ? (
                  <>
                    {' · '}
                    <Timestamp value={placement.scheduledFor} dateOnly />
                  </>
                ) : (
                  ' · no date set'
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill label={placement.status} tone={placementTone(placement.status)} />
              {placement.remoteUrl ? (
                <a
                  href={placement.remoteUrl}
                  className="inline-flex items-center gap-1 text-table text-primary underline-offset-4 hover:underline"
                >
                  Live page
                  <ExternalLink aria-hidden="true" className="h-3 w-3" />
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function placementTone(status: string): StatusTone {
  if (status === 'published') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'publishing') return 'info';
  return 'neutral';
}
