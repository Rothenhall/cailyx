'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { RunConfigurator } from '@/components/patterns/RunConfigurator';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import { listProjectCapabilities, type CapabilityView } from '@/services/admin';
import {
  AUTHORITY_METHOD_LABEL,
  AUTHORITY_METHOD_DESCRIPTION,
  AUTHORITY_METHODS,
  candidateProvenance,
  getAuthorityScan,
  listAuthorityScans,
  parseListicleQueries,
  promoteAuthorityCandidate,
  runAuthorityScan,
  updateAuthorityCandidate,
  type AuthorityCandidate,
  type AuthorityMethod,
  type AuthorityScan,
  type AuthorityScanDetail,
} from '@/services/authority';
import type { ApiError } from '@/lib/api';
import type { ObservedConfiguration, ConfiguratorPrerequisite } from '@/components/patterns/RunConfigurator';

/**
 * AT01 — Authority opportunities.
 *
 * design_plan.md §4.4: *"Discovery method/category/query, ranked candidates,
 * inspect/dismiss/promote to outreach"*, and §5.9:
 *
 * > Authority: run a discovery scan with a selected method; inspect
 * > evidence/relevance; dismiss unsuitable candidates; promote chosen
 * > candidates into mention targets. Promotion creates a ledger record, not an
 * > email.
 *
 * Three rules shape this page.
 *
 *  1. **A candidate is not a target.** Everything in the candidate table is a
 *     *suggestion* — from a search result, a model or an AI-answer citation —
 *     and it is badged with where it came from. Promoting it is what turns it
 *     into a ledger record, and the confirmation says plainly that no one is
 *     contacted (§5.9: "Manual contact occurs outside Cailyx").
 *  2. **Nothing runs on load.** The scan configuration, its prerequisites and
 *     its observed source availability are rendered before one explicit start
 *     button (§10.4's scan/generation row).
 *  3. **A scan that lost a source is not a clean scan.** `status: 'partial'`
 *     with a `note` is surfaced, and promoted/candidate counts are read from
 *     the scan rather than recomputed here.
 */

const FILTER_DEFAULTS = {
  /** The selected scan — a real navigation step, so it pushes history. */
  scan: '',
  /** Scan configuration. Kept in the URL so a configured scan is shareable. */
  method: 'combined',
  category: '',
  queries: '',
  llm: false,
  /** Filters over the candidate table of the selected scan. */
  q: '',
  candidateStatus: 'all',
};

const CANDIDATE_STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'promoted', label: 'Promoted' },
  { value: 'dismissed', label: 'Dismissed' },
];

export default function AuthorityOpportunitiesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const [scans, setScans] = useState<AuthorityScan[] | null>(null);
  const [scanDetail, setScanDetail] = useState<AuthorityScanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilityView[] | null>(null);
  const [capabilitiesUnavailable, setCapabilitiesUnavailable] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<AuthorityCandidate | null>(null);
  const [promoting, setPromoting] = useState<AuthorityCandidate | null>(null);

  const method = (filters.method as AuthorityMethod) ?? 'combined';
  const queries = useMemo(
    () =>
      String(filters.queries ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    [filters.queries],
  );

  const loadScans = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setScans(await listAuthorityScans(projectId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadScans(controller.signal);
    return () => controller.abort();
  }, [loadScans]);

  /**
   * Source readiness.
   *
   * A failure here is not a page failure: it means the prerequisites cannot be
   * shown as facts. The configurator then says so instead of implying the
   * sources are fine — §10.4 forbids enabling a start whose prerequisites the
   * screen cannot see.
   */
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const roster = await listProjectCapabilities(projectId, { signal: controller.signal });
        setCapabilities(roster.capabilities);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setCapabilitiesUnavailable(true);
        setCapabilities([]);
      }
    })();
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    if (!filters.scan) {
      setScanDetail(null);
      return;
    }
    const controller = new AbortController();
    (async () => {
      setDetailLoading(true);
      try {
        setScanDetail(await getAuthorityScan(projectId, filters.scan, { signal: controller.signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setActionError(toApiError(caught));
        setScanDetail(null);
      } finally {
        setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [projectId, filters.scan]);

  /* ── source readiness, derived from the capability roster ── */

  const serpCapabilities = useMemo(
    () => (capabilities ?? []).filter((entry) => entry.category === 'serp-data'),
    [capabilities],
  );
  const llmCapabilities = useMemo(
    () => (capabilities ?? []).filter((entry) => entry.category === 'llm'),
    [capabilities],
  );

  const usesSerp = method === 'serp' || method === 'combined';
  const usesLlm = method === 'llm' || method === 'combined' || filters.llm;
  const usesCitations = method === 'citations' || method === 'combined';

  const prerequisites = useMemo<ConfiguratorPrerequisite[]>(() => {
    const entries: ConfiguratorPrerequisite[] = [];

    if (capabilitiesUnavailable) {
      entries.push({
        label: 'Source readiness could not be read',
        met: false,
        blocking: false,
        detail:
          'The project capability roster did not load, so this page cannot show which discovery sources are configured. Starting a scan will still be refused by the server if a source it needs is missing.',
      });
    }

    if (usesSerp) {
      const ready = serpCapabilities.filter((entry) => entry.state === 'ready');
      entries.push({
        label: 'Search results source',
        met: ready.length > 0,
        detail:
          serpCapabilities.length === 0
            ? 'No search-results provider is registered for this project.'
            : ready.length > 0
              ? ready.map((entry) => entry.label).join(', ')
              : serpCapabilities.map((entry) => `${entry.label}: ${entry.stateDetail}`).join(' '),
      });
    }

    if (usesLlm) {
      const ready = llmCapabilities.filter((entry) => entry.state === 'ready');
      entries.push({
        label: 'Model source',
        met: ready.length > 0,
        detail:
          llmCapabilities.length === 0
            ? 'No model provider is registered for this project.'
            : ready.length > 0
              ? ready.map((entry) => entry.label).join(', ')
              : llmCapabilities.map((entry) => `${entry.label}: ${entry.stateDetail}`).join(' '),
      });
    }

    if (usesCitations) {
      // Advisory: whether this project has journeys or measurement to read is
      // not something the capability roster reports, so it is stated rather
      // than asserted either way.
      entries.push({
        label: 'Existing AI answers to read citations from',
        met: true,
        blocking: false,
        detail:
          'Citation discovery reads the answers this project has already collected. If none exist yet, this source contributes no candidates and the scan reports it as a failed part.',
      });
    }

    if (queries.length === 0 && (method === 'serp' || method === 'combined')) {
      entries.push({
        label: 'At least one listicle query',
        met: false,
        detail:
          'Search-result discovery needs the "best X" style queries to look for. Add one to run this method.',
      });
    }

    return entries;
  }, [
    capabilitiesUnavailable,
    usesSerp,
    usesLlm,
    usesCitations,
    serpCapabilities,
    llmCapabilities,
    queries.length,
    method,
  ]);

  const configuration = useMemo<ObservedConfiguration[]>(() => {
    const relevant = [...(usesSerp ? serpCapabilities : []), ...(usesLlm ? llmCapabilities : [])];
    return relevant.map((entry) => ({
      label: entry.label,
      availability:
        entry.state === 'ready'
          ? 'available'
          : entry.state === 'unverified'
            ? 'unverified'
            : entry.state === 'unmapped'
              ? 'unmapped'
              : 'unavailable',
      detail: entry.stateDetail,
      lastSuccessfulRunAt: entry.lastSuccessAt ?? undefined,
    }));
  }, [usesSerp, usesLlm, serpCapabilities, llmCapabilities]);

  /* ── actions ── */

  async function startScan(): Promise<void> {
    setStartError(null);
    try {
      // Synchronous and potentially slow: the server performs the provider
      // lookups before responding. Deliberately not abortable — dropping the
      // request would not stop the scan, only hide its result.
      const detail = await runAuthorityScan(projectId, {
        method,
        category: String(filters.category ?? '') || undefined,
        listicleQueries: queries.length > 0 ? queries : undefined,
        useLlm: filters.llm ? true : undefined,
      });
      setScanDetail(detail);
      setFilters({ scan: detail.id }, { push: true });
      await loadScans();
    } catch (caught) {
      // The configurator renders this inline and keeps the operator in the
      // context that produced it; the rejection is not re-thrown into a loop.
      setStartError(toApiError(caught));
    }
  }

  async function setCandidateStatus(
    candidate: AuthorityCandidate,
    status: 'new' | 'dismissed',
  ) {
    if (!scanDetail) return;
    setBusyCandidateId(candidate.id);
    setActionError(null);
    try {
      await updateAuthorityCandidate(projectId, scanDetail.id, candidate.id, status);
      setScanDetail(await getAuthorityScan(projectId, scanDetail.id));
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusyCandidateId(null);
    }
  }

  async function confirmPromote() {
    if (!scanDetail || !promoting) return;
    const candidate = promoting;
    setActionError(null);
    await promoteAuthorityCandidate(projectId, scanDetail.id, candidate.id);
    setScanDetail(await getAuthorityScan(projectId, scanDetail.id));
    setPromoting(null);
  }

  /* ── render ── */

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Authority opportunities" />
        <ErrorState error={error} onRetry={() => void loadScans()} />
      </div>
    );
  }

  if (!scans) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const scanColumns: ReadonlyArray<ColumnDef<AuthorityScan>> = [
    {
      key: 'createdAt',
      header: 'Scan',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 210,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'method',
      header: 'Method',
      accessor: (row) => row.method,
      sortable: true,
      width: 150,
      render: (row) => AUTHORITY_METHOD_LABEL[row.method as AuthorityMethod] ?? row.method,
    },
    {
      key: 'category',
      header: 'Category',
      accessor: (row) => row.category,
      width: 160,
      emptyLabel: 'Not set',
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => <StatusPill label={row.status} tone={scanTone(row.status)} />,
    },
    {
      key: 'candidateCount',
      header: 'Candidates',
      accessor: (row) => row.candidateCount,
      sortable: true,
      align: 'right',
      width: 110,
      render: (row) => <span className="tabular-nums">{formatNumber(row.candidateCount)}</span>,
    },
    {
      key: 'promotedCount',
      header: 'Promoted',
      accessor: (row) => row.promotedCount,
      sortable: true,
      align: 'right',
      width: 100,
      render: (row) => <span className="tabular-nums">{formatNumber(row.promotedCount)}</span>,
    },
    {
      key: 'open',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters({ scan: row.id }, { push: true })}
        >
          {filters.scan === row.id ? 'Viewing' : 'View candidates'}
        </Button>
      ),
    },
  ];

  const candidates = scanDetail?.candidates ?? [];
  const query = String(filters.q ?? '').trim().toLowerCase();
  const visibleCandidates = candidates.filter((candidate) => {
    if (filters.candidateStatus !== 'all' && candidate.status !== filters.candidateStatus) {
      return false;
    }
    if (!query) return true;
    return (
      candidate.domain.toLowerCase().includes(query) ||
      candidate.title.toLowerCase().includes(query) ||
      candidate.url.toLowerCase().includes(query)
    );
  });

  const candidateColumns: ReadonlyArray<ColumnDef<AuthorityCandidate>> = [
    {
      key: 'rank',
      header: 'Rank',
      accessor: (row) => row.rank,
      sortable: true,
      align: 'right',
      width: 80,
      // A null rank means the source did not rank candidates (model and
      // citation discoveries), which is not "ranked last".
      emptyLabel: 'Not ranked',
      render: (row) =>
        row.rank === null ? null : <span className="tabular-nums">{formatNumber(row.rank)}</span>,
    },
    {
      key: 'domain',
      header: 'Publication',
      accessor: (row) => row.domain,
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">{row.domain}</div>
          <div className="truncate text-meta text-muted-foreground">{row.title}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      accessor: (row) => row.type,
      sortable: true,
      width: 120,
      render: (row) => <span className="capitalize">{row.type}</span>,
    },
    {
      key: 'discoveredVia',
      header: 'Provenance',
      accessor: (row) => row.discoveredVia,
      width: 210,
      render: (row) => {
        const provenance = candidateProvenance(row.discoveredVia);
        return (
          <div className="space-y-1">
            <ProvenanceBadge kind={provenance.kind} label={provenance.label} />
            <div className="text-meta text-muted-foreground">{describeDiscovery(row.discoveredVia)}</div>
          </div>
        );
      },
    },
    {
      key: 'relevance',
      header: 'Relevance',
      accessor: (row) => row.relevance,
      sortable: true,
      align: 'right',
      width: 110,
      render: (row) => <span className="tabular-nums">{row.relevance.toFixed(2)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => <StatusPill label={row.status} tone={candidateTone(row.status)} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: 280,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setInspecting(row)}>
            Inspect
          </Button>
          {row.status === 'promoted' ? (
            <span className="text-meta text-muted-foreground">
              {row.promotedTargetId ? 'In the outreach ledger' : 'Promoted'}
            </span>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busyCandidateId === row.id}
                onClick={() => setPromoting(row)}
              >
                Promote
              </Button>
              {row.status === 'dismissed' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyCandidateId === row.id}
                  onClick={() => void setCandidateStatus(row, 'new')}
                >
                  Reconsider
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyCandidateId === row.id}
                  onClick={() => void setCandidateStatus(row, 'dismissed')}
                >
                  Dismiss
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Authority opportunities"
        context={
          scans.length === 0
            ? 'No discovery scan has run for this project yet.'
            : `${scans.length} scan${scans.length === 1 ? '' : 's'} on file`
        }
        primaryAction={{ label: 'Configure a scan', href: '#scan-config' }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void loadScans()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* ── Run a discovery scan ─────────────────────────────────────── */}
      <Card id="scan-config">
        <CardHeader>
          <CardTitle className="text-subsection">Run a discovery scan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-table text-muted-foreground">
            A scan looks for places this brand could earn a mention. It contacts nothing:
            candidates are suggestions you review, and only promoting one records it.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="scan-method">Discovery method</Label>
              <Select
                value={method}
                onValueChange={(value) => setFilters({ method: value })}
              >
                <SelectTrigger id="scan-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTHORITY_METHODS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {AUTHORITY_METHOD_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">{AUTHORITY_METHOD_DESCRIPTION[method]}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="scan-category">Category</Label>
              <Input
                id="scan-category"
                value={String(filters.category ?? '')}
                placeholder="e.g. ai visibility tools"
                onChange={(event) => setFilters({ category: event.target.value })}
              />
              <p className="text-meta text-muted-foreground">
                Narrows what counts as a relevant publication. Optional.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scan-queries">Listicle queries</Label>
            <Textarea
              id="scan-queries"
              rows={3}
              value={String(filters.queries ?? '')}
              onChange={(event) => setFilters({ queries: event.target.value })}
              placeholder={'best ai visibility tools\nbest rank tracking software'}
            />
            <p className="text-meta text-muted-foreground">
              One per line. These are the &ldquo;best X&rdquo; pages the search-results method looks
              for, and they are recorded on the scan.
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id="scan-llm"
              checked={filters.llm === true}
              onCheckedChange={(checked) => setFilters({ llm: checked === true })}
            />
            <div className="space-y-1">
              <Label htmlFor="scan-llm">Also ask a model for suggestions</Label>
              <p className="text-meta text-muted-foreground">
                Adds model-proposed candidates alongside the method above. They are badged as model
                interpretation, never as measured data.
              </p>
            </div>
          </div>

          <RunConfigurator
            startLabel="Start discovery scan"
            prerequisites={prerequisites}
            parameters={[
              { key: 'method', label: 'Method', value: AUTHORITY_METHOD_LABEL[method] },
              {
                key: 'category',
                label: 'Category',
                value: String(filters.category ?? '') || 'Not set',
              },
              {
                key: 'queries',
                label: 'Listicle queries',
                value: queries.length > 0 ? queries.join('; ') : 'None',
              },
              { key: 'llm', label: 'Model suggestions', value: filters.llm ? 'Yes' : 'No' },
            ]}
            scope={
              <p>
                Covers this project only ({(filters.category as string) || 'no category filter'}).
                It reads the sources listed below and writes a scan record with its candidates.
                Nothing outside Cailyx is contacted, and no outreach is sent.
              </p>
            }
            configuration={configuration}
            onStart={startScan}
            /* A scan performs its provider lookups before responding, so the
               default 60-second reconcile window would report a lost response
               while the scan is still running. */
            startTimeoutMs={300_000}
            onReconcile={() => void loadScans()}
            error={startError}
            timeZone={undefined}
          />

          {queries.length > 0 && (method === 'serp' || method === 'combined') ? null : (
            <p className="text-meta text-muted-foreground">
              A scan with no listicle queries and no model suggestions still runs, but the
              search-results source will contribute nothing.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Scan history ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Scans</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {scans.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="authority discovery"
              prerequisite="Run a discovery scan above, or record a target by hand on the outreach screen."
            />
          ) : (
            <DataTable
              caption="Authority discovery scans"
              columns={scanColumns}
              rows={scans}
              getRowId={(row) => row.id}
              defaultSort={{ key: 'createdAt', direction: 'desc' }}
              onRowClick={(row) => setFilters({ scan: row.id }, { push: true })}
              emptyState={<EmptyState variant="no-results" />}
              minTableWidth="64rem"
            />
          )}
        </CardContent>
      </Card>

      {/* ── Selected scan ────────────────────────────────────────────── */}
      {detailLoading ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : scanDetail ? (
        <Card>
          <CardHeader className="space-y-2">
            <CardTitle className="text-subsection">
              Candidates from the scan on{' '}
              <Timestamp value={scanDetail.createdAt} className="text-subsection" />
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill label={scanDetail.status} tone={scanTone(scanDetail.status)} />
              <ProvenanceBadge kind="discovered-candidate" />
              <span className="text-meta text-muted-foreground">
                {formatNumber(scanDetail.candidateCount)} candidates ·{' '}
                {formatNumber(scanDetail.promotedCount)} promoted
              </span>
              {scanDetail.model ? (
                <span className="text-meta text-muted-foreground">
                  Model suggestions by {scanDetail.model}
                </span>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-2">
            {scanDetail.status === 'partial' || scanDetail.note ? (
              <Alert>
                <Info aria-hidden="true" className="h-4 w-4" />
                <AlertTitle>This scan did not read every source</AlertTitle>
                <AlertDescription>
                  {scanDetail.note ??
                    'One or more discovery sources did not complete, so the candidates below are what the remaining sources returned.'}
                </AlertDescription>
              </Alert>
            ) : null}

            {scanDetail.error ? (
              <Alert variant="destructive">
                <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                <AlertDescription>{scanDetail.error}</AlertDescription>
              </Alert>
            ) : null}

            <QueriesReadout raw={scanDetail.listicleQueries} />

            <FilterBar
              defaults={FILTER_DEFAULTS}
              value={filters}
              onChange={setFilters}
              controls={[
                {
                  kind: 'select',
                  key: 'candidateStatus',
                  label: 'Candidate status',
                  options: CANDIDATE_STATUS_OPTIONS,
                },
              ]}
              searchPlaceholder="Search domain, title or URL"
              summary={`Showing ${visibleCandidates.length} of ${candidates.length}`}
            />

            {candidates.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="candidates from this scan"
                prerequisite="Re-run the scan with a method whose sources are configured, or with listicle queries supplied."
              />
            ) : (
              <DataTable
                caption="Ranked authority candidates"
                columns={candidateColumns}
                rows={visibleCandidates}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'relevance', direction: 'desc' }}
                emptyState={<EmptyState variant="no-results" onClearFilters={() => setFilters({ q: '', candidateStatus: 'all' })} />}
                minTableWidth="72rem"
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Inspect: the evidence behind one candidate. */}
      {inspecting && scanDetail ? (
        <EvidenceDrawer
          open
          onOpenChange={(open) => {
            if (!open) setInspecting(null);
          }}
          title={`Candidate: ${inspecting.domain}`}
          source={{
            name: `${AUTHORITY_METHOD_LABEL[scanDetail.method as AuthorityMethod] ?? scanDetail.method} discovery scan`,
            capturedAt: scanDetail.finishedAt ?? scanDetail.createdAt,
            runId: scanDetail.id,
            url: inspecting.url,
            query: serpKeyword(inspecting.discoveredVia) ?? undefined,
          }}
          observed={
            <div className="space-y-2">
              <p className="text-table">
                {inspecting.title || '(the scan recorded no title)'}
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-meta">
                <dt className="text-muted-foreground">Publication</dt>
                <dd>{inspecting.domain}</dd>
                <dt className="text-muted-foreground">Type</dt>
                <dd className="capitalize">{inspecting.type}</dd>
                <dt className="text-muted-foreground">Relevance</dt>
                <dd className="tabular-nums">{inspecting.relevance.toFixed(2)}</dd>
                <dt className="text-muted-foreground">Position</dt>
                <dd>{inspecting.rank === null ? 'Not ranked by this source' : inspecting.rank}</dd>
              </dl>
            </div>
          }
          interpretation={inspecting.rationale}
          interpretationKind="model-interpretation"
          raw={{
            label: 'Discovery record',
            text: `discoveredVia: ${inspecting.discoveredVia}\nstatus: ${inspecting.status}\nurl: ${inspecting.url}`,
          }}
          confidence={{
            level: 'unknown',
            basis:
              'The scan records a relevance score but no basis for how that score was arrived at, so no confidence level is asserted here.',
          }}
          provenance={candidateProvenance(inspecting.discoveredVia).kind}
          related={
            inspecting.promotedTargetId
              ? [
                  {
                    label: 'Mention target in the outreach ledger',
                    href: `/projects/${projectId}/authority/targets/${inspecting.promotedTargetId}`,
                    kind: 'work',
                  },
                ]
              : []
          }
        />
      ) : null}

      {/* Promote: creates a ledger record. Nothing is contacted. */}
      <ConfirmDialog
        open={promoting !== null}
        onOpenChange={(open) => {
          if (!open) setPromoting(null);
        }}
        title="Promote this candidate into the outreach ledger?"
        confirmLabel="Promote to target"
        targetLabel="Candidate"
        target={promoting?.domain ?? ''}
        effect={
          <p>
            Creates a mention target with status &ldquo;new&rdquo;. It records the URL so it can be
            tracked and checked later. <strong>No one is contacted</strong> — outreach happens
            outside Cailyx.
          </p>
        }
        onConfirm={confirmPromote}
        onConfirmed={() => setPromoting(null)}
      >
        {promoting ? (
          <div className="space-y-1 text-table">
            <p>{promoting.title || '(no title recorded)'}</p>
            <p className="text-meta text-muted-foreground">
              Discovered via {describeDiscovery(promoting.discoveredVia)} · relevance{' '}
              {promoting.relevance.toFixed(2)}
            </p>
            <p className="text-meta text-muted-foreground">{promoting.url}</p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** The queries a scan used, or an explicit statement that they are unreadable. */
function QueriesReadout({ raw }: { raw: string }) {
  const queries = parseListicleQueries(raw);
  if (queries === null) {
    return (
      <p className="text-meta text-muted-foreground">
        The listicle queries recorded on this scan could not be read
        {raw ? ` (stored value: ${raw})` : ''}. They are shown as unreadable rather than as none.
      </p>
    );
  }
  if (queries.length === 0) {
    return <p className="text-meta text-muted-foreground">This scan used no listicle queries.</p>;
  }
  return (
    <p className="text-meta text-muted-foreground">
      Listicle queries: {queries.join(' · ')}
    </p>
  );
}

/** Human wording for a `discoveredVia` value, without hiding the raw code. */
function describeDiscovery(discoveredVia: string): string {
  const source = (discoveredVia ?? '').trim();
  if (!source) return 'The scan did not record how this was found.';
  if (source.startsWith('serp')) {
    const keyword = serpKeyword(source);
    return keyword ? `Found in results for "${keyword}"` : 'Found in search results';
  }
  if (source === 'llm') return 'Suggested by a model';
  if (source.startsWith('citation:journey')) return 'Cited in an AI answer this project measured';
  if (source.startsWith('citation:measurement')) return 'Cited in AI-answer measurement';
  if (source.startsWith('citation')) return 'Derived from AI answers';
  return `Recorded source: ${source}`;
}

function serpKeyword(discoveredVia: string): string | null {
  const match = /^serp:(.*)$/.exec((discoveredVia ?? '').trim());
  const keyword = match?.[1]?.trim();
  return keyword ? keyword : null;
}

function scanTone(status: string): StatusTone {
  switch (status) {
    case 'complete':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

function candidateTone(status: string): StatusTone {
  switch (status) {
    case 'promoted':
      return 'success';
    case 'dismissed':
      return 'neutral';
    default:
      return 'info';
  }
}
