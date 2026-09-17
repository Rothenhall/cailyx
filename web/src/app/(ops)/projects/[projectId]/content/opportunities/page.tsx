'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw, Search } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ContentAssetType } from '@/services/content';
import {
  OPPORTUNITY_ORIGIN_LABELS,
  OPPORTUNITY_ORIGINS,
  analyzeOpportunities,
  convertOpportunityToContent,
  dismissOpportunity,
  listOpportunities,
  newIdempotencyKey,
  reopenOpportunity,
  researchSearchTerm,
  type Opportunity,
  type OpportunityOrigin,
  type OpportunityStatus,
} from '@/services/opportunities';

/**
 * CT01 — Content opportunities.
 *
 * platform_improvement_plan.md §12.5: "The canonical list lives in Content ->
 * Ideas. Website, AI visibility, Competitors, and reports link to a filtered
 * view or a specific idea." This screen now reads the canonical `Opportunity`
 * model directly (server-side filter + pagination), rather than synthesizing
 * a list from priority-keyword topics and gap-analysis rows on every load —
 * those two feeds remain available from the asset library / gap-analysis
 * screens, but they are no longer this screen's source of truth.
 *
 * §12.6: gaps are computed strictly within the OBSERVED keyword corpus — a
 * null/failed rank is `unknown`, never "not ranking"; missing demand data is
 * `unavailable`, never zero. §12.7: "Create content" is idempotent — a
 * retried click, or a second click once a draft already exists, opens the
 * existing draft rather than creating a duplicate.
 */

const FILTER_DEFAULTS = {
  status: 'all',
  origin: 'all',
  q: '',
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'converted', label: 'Converted' },
];

const ORIGIN_OPTIONS: { value: string; label: string }[] = OPPORTUNITY_ORIGINS.map((o) => ({
  value: o,
  label: OPPORTUNITY_ORIGIN_LABELS[o],
}));

function positionLabel(status: string, position: number | null): string {
  if (status === 'ranked' && position != null) return `#${position}`;
  if (status === 'not-observed') return 'Not found (checked)';
  return notMeasuredLabel();
}

export default function ContentOpportunitiesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ total: number; page: number; pageSize: number; opportunities: Opportunity[] } | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [analyzeSummary, setAnalyzeSummary] = useState<string | null>(null);

  const [dismissTarget, setDismissTarget] = useState<Opportunity | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissError, setDismissError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const [reopenTarget, setReopenTarget] = useState<Opportunity | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [reopening, setReopening] = useState(false);

  const [convertTarget, setConvertTarget] = useState<Opportunity | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<ReturnType<typeof toApiError> | null>(null);

  const [researchOpen, setResearchOpen] = useState(false);
  const [researchKeyword, setResearchKeyword] = useState('');
  const [researching, setResearching] = useState(false);
  const [researchError, setResearchError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [researchDone, setResearchDone] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const res = await listOpportunities(
          projectId,
          {
            status: filters.status === 'all' ? undefined : (filters.status as OpportunityStatus),
            origin: filters.origin === 'all' ? undefined : (filters.origin as OpportunityOrigin),
            search: filters.q || undefined,
            page,
            pageSize: 25,
          },
          { signal },
        );
        setResult(res);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, filters, page],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  async function onAnalyze() {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await analyzeOpportunities(projectId, {});
      setAnalyzeSummary(
        `${res.serpQueriesConsidered} tracked quer${res.serpQueriesConsidered === 1 ? 'y' : 'ies'} and ${res.confirmedCompetitorsConsidered} confirmed competitor${res.confirmedCompetitorsConsidered === 1 ? '' : 's'} considered — ${res.created} created, ${res.updated} updated, ${res.unchanged} unchanged.`,
      );
      await load();
    } catch (caught) {
      setAnalyzeError(toApiError(caught));
    } finally {
      setAnalyzing(false);
    }
  }

  async function onConfirmDismiss() {
    if (!dismissTarget) return;
    setDismissing(true);
    setDismissError(null);
    try {
      await dismissOpportunity(projectId, dismissTarget.id, dismissReason);
      setDismissTarget(null);
      setDismissReason('');
      await load();
    } catch (caught) {
      setDismissError(toApiError(caught));
    } finally {
      setDismissing(false);
    }
  }

  async function onConfirmReopen() {
    if (!reopenTarget) return;
    setReopening(true);
    setReopenError(null);
    try {
      await reopenOpportunity(projectId, reopenTarget.id, reopenReason);
      setReopenTarget(null);
      setReopenReason('');
      await load();
    } catch (caught) {
      setReopenError(toApiError(caught));
    } finally {
      setReopening(false);
    }
  }

  async function onConfirmConvert() {
    if (!convertTarget) return;
    setConverting(true);
    setConvertError(null);
    try {
      await convertOpportunityToContent(projectId, convertTarget.id, {
        idempotencyKey: newIdempotencyKey(),
        assetType: (convertTarget.suggestedContentType as ContentAssetType | null) ?? 'article',
      });
      setConvertTarget(null);
      await load();
    } catch (caught) {
      setConvertError(toApiError(caught));
    } finally {
      setConverting(false);
    }
  }

  async function onResearch() {
    setResearching(true);
    setResearchError(null);
    setResearchDone(null);
    try {
      await researchSearchTerm(projectId, { keyword: researchKeyword });
      setResearchDone(`Researched "${researchKeyword}". Run analysis again to fold it into opportunities.`);
      setResearchKeyword('');
    } catch (caught) {
      setResearchError(toApiError(caught));
    } finally {
      setResearching(false);
    }
  }

  const columns: ReadonlyArray<ColumnDef<Opportunity>> = useMemo(
    () => [
      {
        key: 'topicDisplay',
        header: 'Topic / search term',
        accessor: (row) => row.topicDisplay,
        sortable: true,
        width: 240,
        render: (row) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{row.topicDisplay}</p>
            <p className="text-meta text-muted-foreground">{OPPORTUNITY_ORIGIN_LABELS[row.origin]}</p>
          </div>
        ),
      },
      {
        key: 'reason',
        header: 'Reason',
        accessor: (row) => row.reason,
        width: 320,
      },
      {
        key: 'clientPosition',
        header: 'Client',
        accessor: (row) => row.clientPosition,
        width: 110,
        render: (row) => <span className="tabular-nums">{positionLabel(row.clientPositionStatus, row.clientPosition)}</span>,
      },
      {
        key: 'rivalPosition',
        header: 'Rival',
        accessor: (row) => row.rivalPosition,
        width: 150,
        render: (row) => (
          <span className="tabular-nums">
            {row.rivalName ? `${row.rivalName} ` : ''}
            {positionLabel(row.rivalPositionStatus, row.rivalPosition)}
          </span>
        ),
      },
      {
        key: 'demandVolume',
        header: 'Demand',
        accessor: (row) => row.demandVolume,
        sortable: true,
        align: 'right',
        width: 110,
        render: (row) =>
          row.demandVolume == null ? (
            <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
          ) : (
            <span className="tabular-nums">{formatNumber(row.demandVolume)}</span>
          ),
      },
      {
        key: 'relevance',
        header: 'Relevance',
        accessor: (row) => row.relevance,
        sortable: true,
        align: 'right',
        width: 100,
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        width: 130,
      },
      {
        key: 'actions',
        header: 'Actions',
        accessor: () => '',
        width: 260,
        render: (row) => (
          <div className="flex flex-wrap items-center gap-2">
            {row.status === 'converted' && row.linkedGrowthAssetId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${projectId}/content`}>Open existing draft</Link>
              </Button>
            ) : row.status !== 'dismissed' ? (
              <Button variant="outline" size="sm" onClick={() => setConvertTarget(row)}>
                Create content
              </Button>
            ) : null}
            {row.status === 'dismissed' ? (
              <Button variant="ghost" size="sm" onClick={() => setReopenTarget(row)}>
                Reopen
              </Button>
            ) : row.status === 'new' || row.status === 'in-progress' ? (
              <Button variant="ghost" size="sm" onClick={() => setDismissTarget(row)}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [projectId],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content opportunities" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content opportunities"
        context="The canonical idea list (§12.5): observed-corpus keyword gaps against confirmed competitors, plus keyword-research topic suggestions. Website, Competitors and reports link into this same list rather than keeping their own copies."
        primaryAction={{
          label: analyzing ? 'Analyzing…' : 'Run gap analysis',
          onClick: () => void onAnalyze(),
          disabled: analyzing,
        }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setResearchOpen(true)}>
              <Search aria-hidden="true" className="mr-2 h-4 w-4" />
              Research a search term
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content`}>Asset library</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {analyzeError ? <ErrorState error={analyzeError} layout="inline" /> : null}
      {analyzeSummary ? (
        <Alert>
          <AlertTitle>Analysis complete</AlertTitle>
          <AlertDescription>{analyzeSummary}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Opportunities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-meta text-muted-foreground">
            Gaps are computed only within this project&rsquo;s observed keyword corpus (tracked SERP
            queries + keyword research) — never a claim of a rival&rsquo;s full ranking universe. A
            null/failed capture reads &ldquo;{notMeasuredLabel()}&rdquo;, never &ldquo;not
            ranking&rdquo;.
          </p>
          <FilterBar
            defaults={FILTER_DEFAULTS}
            value={filters}
            onChange={setFilters}
            searchPlaceholder="Search topic…"
            searchKey="q"
            controls={[
              { kind: 'select', key: 'status', label: 'Status', options: STATUS_OPTIONS },
              { kind: 'select', key: 'origin', label: 'Origin', options: ORIGIN_OPTIONS },
            ]}
            summary={`Showing ${result.opportunities.length} of ${result.total}`}
          />

          <DataTable
            caption="Content opportunities"
            columns={columns}
            rows={result.opportunities}
            getRowId={(row) => row.id}
            minTableWidth="70rem"
            emptyState={
              result.total === 0 ? (
                <EmptyState variant="not-measured" subject="content opportunities" prerequisite="a gap analysis run for this project">
                  No opportunities exist yet. Run the gap analysis above, or add one via &ldquo;Research
                  a search term&rdquo;.
                </EmptyState>
              ) : (
                <EmptyState variant="no-results" onClearFilters={() => setFilters(FILTER_DEFAULTS)} />
              )
            }
          />

          {result.total > result.pageSize ? (
            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </Button>
              <span className="text-meta text-muted-foreground">
                Page {page} of {Math.ceil(result.total / result.pageSize)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= Math.ceil(result.total / result.pageSize)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Dismiss ─────────────────────────────────────────────────── */}
      <Dialog open={dismissTarget != null} onOpenChange={(open) => !open && setDismissTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss &ldquo;{dismissTarget?.topicDisplay}&rdquo;?</DialogTitle>
            <DialogDescription>
              A reason is required. Re-running the gap analysis will never silently reopen this —
              only an explicit reopen with its own new reason can.
            </DialogDescription>
          </DialogHeader>
          {dismissError ? <ErrorState error={dismissError} layout="inline" /> : null}
          <div className="space-y-2">
            <Label htmlFor="dismiss-reason">Reason</Label>
            <Textarea id="dismiss-reason" value={dismissReason} onChange={(e) => setDismissReason(e.target.value)} rows={3} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => void onConfirmDismiss()} disabled={dismissing || dismissReason.trim().length < 3}>
              {dismissing ? 'Dismissing…' : 'Dismiss opportunity'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reopen ──────────────────────────────────────────────────── */}
      <Dialog open={reopenTarget != null} onOpenChange={(open) => !open && setReopenTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen &ldquo;{reopenTarget?.topicDisplay}&rdquo;?</DialogTitle>
            <DialogDescription>Give a new reason — distinct from the original dismissal.</DialogDescription>
          </DialogHeader>
          {reopenError ? <ErrorState error={reopenError} layout="inline" /> : null}
          <div className="space-y-2">
            <Label htmlFor="reopen-reason">Reason</Label>
            <Textarea id="reopen-reason" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} rows={3} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => void onConfirmReopen()} disabled={reopening || reopenReason.trim().length < 3}>
              {reopening ? 'Reopening…' : 'Reopen opportunity'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Create content (§12.7) ──────────────────────────────────── */}
      <Dialog open={convertTarget != null} onOpenChange={(open) => !open && setConvertTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create content from &ldquo;{convertTarget?.topicDisplay}&rdquo;?</DialogTitle>
            <DialogDescription>
              Creates a brief-stage {convertTarget?.suggestedContentType ?? 'article'} asset linked to this
              opportunity. Idempotent — retrying never creates a duplicate. The opportunity moves to
              in-progress and is preserved, not deleted.
            </DialogDescription>
          </DialogHeader>
          {convertError ? <ErrorState error={convertError} layout="inline" /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => void onConfirmConvert()} disabled={converting}>
              {converting ? 'Creating…' : 'Create content'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Research a search term (§12.6 R29 / §12.7) ─────────────────── */}
      <Dialog open={researchOpen} onOpenChange={setResearchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Research a search term</DialogTitle>
            <DialogDescription>
              Reuses keyword research&rsquo;s existing DataForSEO lookup and cost gates. Requires
              SWARM_ALLOW_LIVE and DataForSEO credentials to be configured.
            </DialogDescription>
          </DialogHeader>
          {researchError ? <ErrorState error={researchError} layout="inline" /> : null}
          {researchDone ? (
            <Alert>
              <AlertTitle>Done</AlertTitle>
              <AlertDescription>{researchDone}</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="research-keyword">Keyword</Label>
            <Input id="research-keyword" value={researchKeyword} onChange={(e) => setResearchKeyword(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResearchOpen(false)}>
              Close
            </Button>
            <Button onClick={() => void onResearch()} disabled={researching || researchKeyword.trim().length < 2}>
              {researching ? 'Researching…' : 'Research'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
