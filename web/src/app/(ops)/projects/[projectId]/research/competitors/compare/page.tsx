'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  getCompetitorGap,
  getResearchScope,
  listCompetitorProfiles,
  type CompetitorWithProfile,
  type GapResult,
  type ResearchScope,
} from '@/services/research-library';

/**
 * CO02 — Competitor comparison.
 *
 * design_plan.md §4.3: *"Side-by-side tech/schema/SEO/content/presence,
 * evidence dates and comparable-scope warnings"*; the family contract adds
 * *"no invented overall competitor score"*.
 *
 * The comparisons below are **four separate tables**, one per dimension, not a
 * weighted matrix. §1.5 and the gap endpoint's own note are explicit that the
 * data does not support a composite: a rival having more schema types is not
 * "better" in a way that can be added to a homepage score, and the endpoint
 * "does not invent one".
 *
 * Two things this page is careful about, both of which are the difference
 * between a comparison and a misleading one:
 *
 *  1. **A blank cell is not an absence.** A rival whose profile was `skipped`
 *     (no domain) or `failed` (unreachable site) contributes no observations.
 *     Showing that as "does not have it" would turn "we could not look" into
 *     "they do not do this". Every cell therefore resolves to one of
 *     `has / not found / not measured`, and the availability comes from each
 *     rival's own profile statuses rather than from an empty array.
 *  2. **Every figure carries the date it was captured.** Rivals are profiled on
 *     different days, AI-answer standings come from one audit and SERP presence
 *     from one snapshot; those dates are shown per side, so a reader can see
 *     that a comparison is being made across different capture times.
 *
 * The client's own presence column carries a caveat the backend states and this
 * screen repeats: it is built from stored digital-presence rows, so a client
 * who has never had a presence scan shows as having none rather than as having
 * been checked.
 */
export default function CompetitorComparisonPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [gap, setGap] = useState<GapResult | null>(null);
  const [profiles, setProfiles] = useState<CompetitorWithProfile[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [gapResult, profilesResult] = await Promise.all([
          getCompetitorGap(projectId, { signal }),
          listCompetitorProfiles(projectId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setGap(gapResult);
        setProfiles(profilesResult);
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

  /**
   * One side of the comparison. The client is always present; rivals come from
   * the gap rows so the two endpoints cannot disagree about who is in scope.
   */
  const sides = useMemo<Side[]>(() => {
    if (!gap) return [];
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    return [
      {
        id: '__client__',
        label: scope?.projectName ?? 'This client',
        domain: gap.domain,
        isClient: true,
        competitorId: null,
        profile: null,
        gapRow: null,
        profileDate: gap.generatedAt,
        profileDateLabel: 'Gap comparison generated',
      },
      ...gap.competitors.map((row) => {
        const profile = profileById.get(row.competitorId) ?? null;
        return {
          id: row.competitorId,
          label: row.name,
          domain: row.domain,
          isClient: false,
          competitorId: row.competitorId,
          profile,
          gapRow: row,
          profileDate: profile?.latestProfile?.createdAt ?? null,
          profileDateLabel: 'Profile built',
        };
      }),
    ];
  }, [gap, profiles, scope]);

  /**
   * Where a comparison is limited by what was actually observed. Each rival's
   * own latest profile status decides this, so a `skipped` or `failed` crawl
   * reads as "not measured" rather than as an absence of the thing.
   */
  const scopeWarnings = useMemo(() => {
    if (!gap) return [];
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    const warnings: string[] = [];
    for (const row of gap.competitors) {
      const latest = profileById.get(row.competitorId)?.latestProfile ?? null;
      if (!latest) {
        warnings.push(
          `${row.name} has no profile yet, so nothing about its tech, schema or presence has been observed. Its cells read "not measured", not "absent".`,
        );
        continue;
      }
      if (latest.status === 'skipped' || latest.status === 'failed') {
        warnings.push(
          `${row.name}’s homepage profile is ${latest.status}${latest.error ? ` — ${latest.error}` : ''}, so its tech and schema cells read "not measured".`,
        );
      }
      if (latest.presenceStatus !== 'completed') {
        warnings.push(
          `${row.name}’s external-presence crawl is ${latest.presenceStatus}${latest.presenceError ? ` — ${latest.presenceError}` : ''}.`,
        );
      }
      if (latest.seoStatus !== 'completed') {
        warnings.push(
          `${row.name}’s homepage SEO and content read is ${latest.seoStatus}${latest.seoError ? ` — ${latest.seoError}` : ''}.`,
        );
      }
      if (latest.reviewStatus !== 'completed') {
        warnings.push(
          `${row.name}’s published-rating read is ${latest.reviewStatus}${latest.reviewError ? ` — ${latest.reviewError}` : ''}.`,
        );
      }
    }
    if (gap.presence.client.length === 0) {
      warnings.push(
        'The client side of the external-presence comparison is built from stored digital-presence rows. An empty list here means no presence scan has run, not that the client has no profiles.',
      );
    }
    return warnings;
  }, [gap, profiles]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Competitor comparison" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!gap || !profiles) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const metricColumns: ReadonlyArray<ColumnDef<Side>> = [
    {
      key: 'side',
      header: 'Side',
      accessor: (row) => row.label,
      sortable: true,
      width: 220,
      render: (row) => (
        <span className="font-medium">
          {row.label}
          {row.isClient ? (
            <span className="ml-2 text-meta font-normal text-muted-foreground">(this client)</span>
          ) : null}
          {row.domain ? (
            <div className="text-meta font-normal text-muted-foreground">{row.domain}</div>
          ) : null}
        </span>
      ),
    },
    {
      key: 'evidenceDate',
      header: 'Evidence captured',
      accessor: (row) => row.profileDate,
      sortable: true,
      width: 210,
      emptyLabel: 'Never profiled',
      render: (row) => (
        <div className="text-meta">
          {row.profileDate ? (
            <>
              <Timestamp value={row.profileDate} />
              <div className="text-muted-foreground">{row.profileDateLabel}</div>
            </>
          ) : null}
        </div>
      ),
    },
    {
      key: 'tech',
      header: 'Tech findings',
      accessor: (row) => row.isClient ? gap.tech.client.length : techKeyCount(row, gap),
      sortable: true,
      align: 'right',
      width: 140,
      emptyLabel: notMeasuredLabel(),
      render: (row) => (
        <MeasuredNumber
          value={row.isClient ? gap.tech.client.length : techKeyCount(row, gap)}
          available={row.isClient || isProfileDimensionMeasured(row, 'tech')}
        />
      ),
    },
    {
      key: 'schema',
      header: 'Schema types',
      accessor: (row) => row.isClient ? gap.schema.client.length : schemaKeyCount(row, gap),
      sortable: true,
      align: 'right',
      width: 140,
      emptyLabel: notMeasuredLabel(),
      render: (row) => (
        <MeasuredNumber
          value={row.isClient ? gap.schema.client.length : schemaKeyCount(row, gap)}
          available={row.isClient || isProfileDimensionMeasured(row, 'schema')}
        />
      ),
    },
    {
      key: 'presence',
      header: 'External profiles',
      accessor: (row) => row.isClient ? gap.presence.client.length : (row.gapRow?.presencePlatforms.length ?? null),
      sortable: true,
      align: 'right',
      width: 150,
      emptyLabel: notMeasuredLabel(),
      render: (row) => (
        <MeasuredNumber
          value={row.isClient ? gap.presence.client.length : (row.gapRow?.presencePlatforms.length ?? null)}
          available={row.isClient || isProfileDimensionMeasured(row, 'presence')}
        />
      ),
    },
    {
      key: 'seo',
      header: 'Homepage score',
      accessor: (row) => row.isClient ? gap.seo.client.score : (row.gapRow?.seoScore ?? null),
      sortable: true,
      align: 'right',
      width: 150,
      emptyLabel: notMeasuredLabel(),
      render: (row) => (
        <MeasuredNumber
          value={row.isClient ? gap.seo.client.score : (row.gapRow?.seoScore ?? null)}
          available={row.isClient || isProfileDimensionMeasured(row, 'seo')}
        />
      ),
    },
    {
      key: 'content',
      header: 'Homepage content read',
      accessor: (row) => {
        const signals = row.isClient ? gap.seo.client.contentSignals : (row.gapRow?.contentSignals ?? null);
        return signals ? signals.wordCount : null;
      },
      sortable: true,
      align: 'right',
      width: 210,
      emptyLabel: notMeasuredLabel(),
      render: (row) => {
        const signals = row.isClient ? gap.seo.client.contentSignals : (row.gapRow?.contentSignals ?? null);
        if (!isProfileDimensionMeasured(row, 'seo') && !row.isClient) {
          return <NotMeasured />;
        }
        if (!signals) return <NotMeasured />;
        return (
          <span className="text-meta">
            <span className="tabular-nums">{formatNumber(signals.wordCount)}</span> words ·{' '}
            <span className="tabular-nums">{signals.h1Count}</span> h1 ·{' '}
            <span className="tabular-nums">{signals.imagesMissingAlt}</span> images without alt ·
            JSON-LD <span className="tabular-nums">{signals.jsonLdCount}</span>
            {signals.noindex ? ' · noindex' : ''}
          </span>
        );
      },
    },
    {
      key: 'reviews',
      header: 'Published ratings',
      accessor: (row) => row.isClient ? gap.reviews.client.length : (row.gapRow?.reviewRatings.length ?? null),
      sortable: true,
      align: 'right',
      width: 170,
      emptyLabel: notMeasuredLabel(),
      render: (row) => {
        const rows = row.isClient
          ? gap.reviews.client
          : (row.gapRow?.reviewRatings ?? []).map((rating) => ({
              platform: rating.platform,
              label: rating.label,
              rating: rating.rating,
              ratingCount: rating.ratingCount,
            }));
        if (!row.isClient && !isProfileDimensionMeasured(row, 'reviews')) return <NotMeasured />;
        if (rows.length === 0) {
          return <span className="text-meta text-muted-foreground">No published rating found</span>;
        }
        return (
          <span className="text-meta">
            {rows
              .map(
                (entry) =>
                  `${entry.label}: ${entry.rating ?? '—'}${
                    entry.ratingCount !== null && entry.ratingCount !== undefined
                      ? ` (${formatNumber(entry.ratingCount)})`
                      : ''
                  }`,
              )
              .join(' · ')}
          </span>
        );
      },
    },
    {
      key: 'aeo',
      header: 'AI-answer standing',
      accessor: (row) => row.gapRow?.aeoStanding?.mentionRate ?? null,
      sortable: true,
      align: 'right',
      width: 210,
      emptyLabel: notMeasuredLabel(),
      render: (row) => {
        if (row.isClient) {
          return (
            <span className="text-meta text-muted-foreground">
              Client standing is on the AI-visibility screen, counted over its own answers.
            </span>
          );
        }
        if (row.gapRow?.aeoStatus !== 'present' || !row.gapRow.aeoStanding) {
          return (
            <StatusPill
              label={attachStatusLabel(row.gapRow?.aeoStatus ?? 'unknown', 'answers')}
              tone={attachStatusTone(row.gapRow?.aeoStatus ?? 'unknown')}
            />
          );
        }
        const standing = row.gapRow.aeoStanding;
        return (
          <span className="text-meta">
            mentioned in <span className="tabular-nums">{formatNumber(standing.mentionRate)}%</span>{' '}
            of <span className="tabular-nums">{standing.observations}</span> answers
            {standing.shareOfVoice !== null ? (
              <>
                {' '}
                · share <span className="tabular-nums">{formatNumber(standing.shareOfVoice)}%</span>
              </>
            ) : null}
            {standing.generatedAt ? (
              <div className="text-muted-foreground">
                from an audit generated <Timestamp value={standing.generatedAt} />
              </div>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'serp',
      header: 'SERP presence',
      accessor: (row) => row.gapRow?.serpPresence?.bestRank ?? null,
      sortable: true,
      align: 'right',
      width: 210,
      emptyLabel: notMeasuredLabel(),
      render: (row) => {
        if (row.isClient) {
          return (
            <span className="text-meta text-muted-foreground">
              The client&rsquo;s own positions are on the search-tracker screens, per keyword and
              per market.
            </span>
          );
        }
        const presence = row.gapRow?.serpPresence;
        if (row.gapRow?.serpStatus !== 'present' || !presence) {
          return (
            <StatusPill
              label={attachStatusLabel(row.gapRow?.serpStatus ?? 'unknown', 'trackers')}
              tone={attachStatusTone(row.gapRow?.serpStatus ?? 'unknown')}
            />
          );
        }
        return (
          <span className="text-meta">
            seen in <span className="tabular-nums">{presence.occurrences}</span> tracked results ·
            best position <span className="tabular-nums">{presence.bestRank ?? '—'}</span>
            {presence.sampleKeyword ? (
              <div className="text-muted-foreground">
                sample keyword: <span className="evidence">{presence.sampleKeyword}</span>
              </div>
            ) : null}
            {presence.capturedAt ? (
              <div className="text-muted-foreground">
                captured <Timestamp value={presence.capturedAt} />
              </div>
            ) : null}
          </span>
        );
      },
    },
  ];

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
          { label: 'Competitors', href: `/projects/${projectId}/research/competitors` },
          { label: 'Compare' },
        ]}
        title="Competitor comparison"
        context={`${sides.length} side${sides.length === 1 ? '' : 's'} in scope`}
        status={
          <span className="text-meta text-muted-foreground">
            Comparison generated <Timestamp value={gap.generatedAt} />
          </span>
        }
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <Alert>
        <AlertTitle>There is no overall competitor score here, and none is derived</AlertTitle>
        <AlertDescription>
          The four comparisons below are separate measurements: a technology diff, a structured-data
          diff, an external-presence diff, and per-side readings of homepage SEO, content and
          reviews. They cover different populations and different capture dates, and nothing here
          adds them into a rank. The endpoint behind this screen states the same thing: the data does
          not support a composite score, so it does not invent one.
        </AlertDescription>
      </Alert>

      {scopeWarnings.length > 0 ? (
        <Alert>
          <AlertTitle>
            Comparable scope: {scopeWarnings.length} limitation
            {scopeWarnings.length === 1 ? '' : 's'} to read this comparison with
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-5">
              {scopeWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>Comparable scope: every side has a completed profile</AlertTitle>
          <AlertDescription>
            Each rival below has a profile built from its own homepage, read with the client&rsquo;s
            own rubric. Capture dates are shown per side so a difference in observation time stays
            visible.
          </AlertDescription>
        </Alert>
      )}

      {sides.length === 1 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="A side-by-side comparison"
              prerequisite="There is nothing to compare against yet. Add competitors to the benchmark list, then build their profiles — one homepage fetch each."
              action={{
                label: 'Open the competitors screen',
                href: `/projects/${projectId}/research/competitors`,
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Readings, side by side</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                A cell reading <strong>{notMeasuredLabel().toLowerCase()}</strong> means that
                dimension was not observed for that side — never that the side was observed and had
                nothing there.
              </p>
              <DataTable
                caption="Competitor comparison"
                columns={metricColumns}
                rows={sides}
                getRowId={(row) => row.id}
                minTableWidth="92rem"
                rowDetail={(row) => <SideDetail side={row} />}
              />
              <p className="text-meta text-muted-foreground">{gap.seo.note}</p>
              <p className="text-meta text-muted-foreground">{gap.reviews.note}</p>
            </CardContent>
          </Card>

          <DimensionMatrix
            title="Technology, per side"
            dimension="tech"
            description="Findings from each side's homepage tech scan. A rival with no completed scan is marked not measured rather than counted as having nothing."
            sides={sides}
            clientKeys={gap.tech.client}
            shared={gap.tech.shared}
            competitorsOnly={gap.tech.competitorsOnly}
          />

          <DimensionMatrix
            title="Structured data types, per side"
            dimension="schema"
            description="Schema.org @type values read from each side's homepage JSON-LD."
            sides={sides}
            clientKeys={gap.schema.client}
            shared={gap.schema.shared}
            competitorsOnly={gap.schema.competitorsOnly}
          />

          <DimensionMatrix
            title="External presence platforms, per side"
            dimension="presence"
            description="Company profiles only — a founder's personal profile is not the company's footprint and is excluded. Candidate and personal rows are excluded too."
            sides={sides}
            clientKeys={gap.presence.client}
            shared={gap.presence.shared}
            competitorsOnly={gap.presence.competitorsOnly}
          />

          <p className="text-meta text-muted-foreground">{gap.presence.client.length === 0 ? gap.note : ''}</p>
        </>
      )}
    </div>
  );
}

/** One row of the metric table: the client, or one rival. */
interface Side {
  id: string;
  label: string;
  domain: string | null;
  isClient: boolean;
  competitorId: string | null;
  profile: CompetitorWithProfile | null;
  gapRow: GapResult['competitors'][number] | null;
  profileDate: string | null;
  profileDateLabel: string;
}

/** `null` renders §3.5's "Not measured yet"; a number renders itself. */
function MeasuredNumber({ value, available }: { value: number | null; available: boolean }) {
  if (!available) return <NotMeasured />;
  if (value === null || value === undefined) return <NotMeasured />;
  return <span className="tabular-nums">{formatNumber(value)}</span>;
}

function NotMeasured() {
  return (
    <span className="text-meta text-unmeasured-foreground">{notMeasuredLabel()}</span>
  );
}

function SideDetail({ side }: { side: Side }) {
  const profile = side.profile?.latestProfile ?? null;
  return (
    <div className="space-y-1 text-table">
      {side.isClient ? (
        <p className="text-muted-foreground">
          The client&rsquo;s own figures come from this comparison run, generated at the date shown.
        </p>
      ) : !profile ? (
        <p className="text-unmeasured-foreground">
          No profile has been built for this competitor, so nothing about it has been observed.
        </p>
      ) : (
        <>
          <p className="text-meta text-muted-foreground">
            Profile status: {profile.status}
            {profile.error ? ` — ${profile.error}` : ''}
          </p>
          <p className="text-meta text-muted-foreground">
            Presence crawl: {profile.presenceStatus}
            {profile.presenceError ? ` — ${profile.presenceError}` : ''}
          </p>
          <p className="text-meta text-muted-foreground">
            SEO read: {profile.seoStatus}
            {profile.seoError ? ` — ${profile.seoError}` : ''}
          </p>
          <p className="text-meta text-muted-foreground">
            Review read: {profile.reviewStatus}
            {profile.reviewError ? ` — ${profile.reviewError}` : ''}
          </p>
          {profile.seoIssues.length > 0 ? (
            <p className="text-meta">
              <span className="text-muted-foreground">Homepage issues:</span>{' '}
              {profile.seoIssues.join(', ')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function DimensionMatrix({
  title,
  description,
  dimension,
  sides,
  clientKeys,
  shared,
  competitorsOnly,
}: {
  title: string;
  description: string;
  /** Which profile status gates every rival cell in this matrix. */
  dimension: 'tech' | 'schema' | 'presence';
  sides: Side[];
  clientKeys: string[];
  shared: Array<{ key: string; competitors: string[] }>;
  competitorsOnly: Array<{ key: string; competitors: string[] }>;
}) {
  const rivals = sides.filter((side) => !side.isClient);
  const clientSet = new Set(clientKeys);

  /** key -> rival names that were observed holding it. */
  const holders = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const line of [...shared, ...competitorsOnly]) {
      const set = map.get(line.key) ?? new Set<string>();
      for (const name of line.competitors) set.add(name);
      map.set(line.key, set);
    }
    return map;
  }, [shared, competitorsOnly]);

  const keys = useMemo(
    () => [...new Set([...clientKeys, ...shared.map((l) => l.key), ...competitorsOnly.map((l) => l.key)])].sort(),
    [clientKeys, shared, competitorsOnly],
  );

  const columns: ReadonlyArray<ColumnDef<string>> = [
    {
      key: 'key',
      header: 'Item',
      accessor: (row) => row,
      sortable: true,
      width: 260,
      cellClassName: 'whitespace-normal',
    },
    {
      key: 'client',
      header: sides[0]?.label ?? 'Client',
      width: 180,
      render: (key) => (
        <span className="text-meta">
          {clientSet.has(key) ? 'Present' : 'Not found'}
        </span>
      ),
    },
    ...rivals.map(
      (side): ColumnDef<string> => ({
        key: side.id,
        header: side.label,
        width: 180,
        cellClassName: 'whitespace-normal',
        render: (key) => {
          if (!isProfileDimensionMeasured(side, dimension)) {
            return <NotMeasured />;
          }
          const has = holders.get(key)?.has(side.label) ?? false;
          return <span className="text-meta">{has ? 'Present' : 'Not found'}</span>;
        },
      }),
    ),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-2">
        <p className="text-meta text-muted-foreground">{description}</p>
        <DataTable
          caption={title}
          columns={columns}
          rows={keys}
          getRowId={(row) => row}
          defaultSort={{ key: 'key', direction: 'asc' }}
          minTableWidth="60rem"
          searchable
          pageSize={50}
          emptyState={
            <EmptyState
              variant="not-measured"
              subject={title}
              prerequisite="Nothing has been read for any side in this dimension yet."
              layout="inline"
            />
          }
        />
      </CardContent>
    </Card>
  );
}

function isProfileDimensionMeasured(
  side: Side,
  dimension: 'tech' | 'schema' | 'presence' | 'seo' | 'reviews',
): boolean {
  if (side.isClient) return true;
  const profile = side.profile?.latestProfile;
  if (!profile) return false;
  switch (dimension) {
    case 'presence':
      return profile.presenceStatus === 'completed';
    case 'seo':
      return profile.seoStatus === 'completed';
    case 'reviews':
      return profile.reviewStatus === 'completed';
    case 'tech':
    case 'schema':
      // Both are read from the same homepage fetch, so they gate on the
      // profile's own overall status rather than a separate one.
      return profile.status === 'completed';
    default:
      return false;
  }
}

function techKeyCount(side: Side, gap: GapResult): number | null {
  if (!side.gapRow) return null;
  if (!isProfileDimensionMeasured(side, 'tech')) return null;
  return gap.tech.competitorsOnly
    .concat(gap.tech.shared)
    .filter((line) => line.competitors.includes(side.label)).length;
}

function schemaKeyCount(side: Side, gap: GapResult): number | null {
  if (!side.gapRow) return null;
  if (!isProfileDimensionMeasured(side, 'schema')) return null;
  return gap.schema.competitorsOnly
    .concat(gap.schema.shared)
    .filter((line) => line.competitors.includes(side.label)).length;
}

function attachStatusTone(status: string): StatusTone {
  switch (status) {
    case 'present':
      return 'success';
    case 'absent':
      return 'neutral';
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
