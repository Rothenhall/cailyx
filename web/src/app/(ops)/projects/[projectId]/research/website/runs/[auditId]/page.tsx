'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { RunStatusStrip } from '@/components/patterns/RunStatusStrip';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import type { CoverageSummary } from '@/types';
import {
  findingRawText,
  findingReason,
  getTechnicalAudit,
  technicalCheckLabel,
  type TechnicalAuditDetail,
  type TechnicalFinding,
  type TechnicalPageRow,
} from '@/services/research';

/**
 * TA02 — Technical run detail.
 *
 * design_plan.md §4.3: *"Robots/CDN/JS/CWV/schema, page inventory, severity,
 * confidence, reproduction evidence"*, under the run/evidence-detail family
 * contract: *"Sticky scope/run header, status or comparison pair, section index,
 * evidence table, detail drawer; raw answer/check behind disclosure; copy
 * URL/reproduction text with clear source."*
 *
 * Every clause of that row is a structure here, not a convention:
 *
 *  - the scope banner is `sticky` so the run being read is never ambiguous;
 *  - the status strip sits directly under it and names the failed or
 *    deferred checks rather than collapsing to a green tick;
 *  - a section index links the four blocks, because a run detail is long;
 *  - the checks and the page inventory are `DataTable`s whose rows open an
 *    `EvidenceDrawer` — the raw check output and the fetch facts are behind
 *    that disclosure, rendered as escaped text (§10.5), with the reproduction
 *    commands copyable next to their source.
 */

type OpenEvidence =
  | { kind: 'check'; finding: TechnicalFinding }
  | { kind: 'page'; page: TechnicalPageRow };

export default function TechnicalRunPage() {
  const { projectId, auditId } = useParams<{ projectId: string; auditId: string }>();

  const [audit, setAudit] = useState<TechnicalAuditDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<OpenEvidence | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setAudit(await getTechnicalAudit(projectId, auditId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, auditId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const coverage = useMemo((): CoverageSummary | null => {
    if (!audit) return null;
    return {
      expectedCount: audit.findings.length,
      successfulCount: audit.findings.filter((f) => f.status === 'pass' || f.status === 'fail').length,
      failed: audit.findings
        .filter((f) => f.status === 'error')
        .map((f) => ({ name: technicalCheckLabel(f.type), reason: findingReason(f) })),
      deferred: audit.findings
        .filter((f) => f.status === 'not-run')
        .map((f) => ({ name: technicalCheckLabel(f.type), reason: findingReason(f) })),
    };
  }, [audit]);

  const findingColumns: ReadonlyArray<ColumnDef<TechnicalFinding>> = [
    {
      key: 'check',
      header: 'Check',
      accessor: (row) => technicalCheckLabel(row.type),
      sortable: true,
      width: 190,
    },
    {
      key: 'status',
      header: 'Result',
      accessor: (row) => row.status,
      sortable: true,
      width: 120,
      render: (row) => <StatusPill label={checkStatusLabel(row.status)} tone={checkStatusTone(row.status)} />,
    },
    {
      key: 'severity',
      header: 'Severity',
      accessor: (row) => row.severity,
      sortable: true,
      width: 110,
      render: (row) => <StatusPill label={titleCase(row.severity)} tone={severityTone(row.severity)} />,
    },
    {
      key: 'confidence',
      header: 'Confidence',
      accessor: (row) => row.confidence,
      sortable: true,
      width: 120,
      // §6.4 — a deduced result is labelled as deduced, never presented as a
      // direct observation.
      render: (row) => <span className="text-table">{confidenceLabel(row.confidence)}</span>,
    },
    {
      key: 'fix',
      header: 'What the check concluded',
      accessor: (row) => row.recommendedFix,
      render: (row) => (
        <span className="block max-w-[36rem] text-table text-foreground">{row.recommendedFix}</span>
      ),
    },
    {
      key: 'evidence',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: 'check', finding: row })}>
          Evidence
        </Button>
      ),
    },
  ];

  const pageColumns: ReadonlyArray<ColumnDef<TechnicalPageRow>> = [
    {
      key: 'url',
      header: 'Page',
      accessor: (row) => row.url,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[28rem] truncate font-mono text-meta" title={row.url}>
          {row.url}
        </span>
      ),
    },
    {
      key: 'score',
      header: 'Score',
      accessor: (row) => row.score,
      sortable: true,
      align: 'right',
      width: 90,
      emptyLabel: 'Not scored',
      render: (row) =>
        typeof row.score === 'number' ? (
          <span className="font-semibold tabular-nums">{formatNumber(row.score)}</span>
        ) : null,
    },
    {
      key: 'fetch',
      header: 'Fetch',
      accessor: (row) => row.status,
      width: 100,
      render: (row) => (
        <span className="tabular-nums">{row.status > 0 ? row.status : 'Failed'}</span>
      ),
    },
    {
      key: 'words',
      header: 'Words',
      accessor: (row) => row.wordCount,
      sortable: true,
      align: 'right',
      width: 100,
      emptyLabel: 'Not measured',
    },
    {
      key: 'jsonld',
      header: 'JSON-LD',
      accessor: (row) => (row.jsonLdTypes.length > 0 ? row.jsonLdTypes.join(', ') : ''),
      width: 140,
      emptyLabel: 'None found',
      render: (row) =>
        row.jsonLdTypes.length > 0 ? (
          <span className="text-meta">{row.jsonLdTypes.join(', ')}</span>
        ) : (
          <span className="text-muted-foreground">None found</span>
        ),
    },
    {
      key: 'issues',
      header: 'Issues',
      accessor: (row) => row.issues.join(', '),
      width: 90,
      align: 'right',
      render: (row) =>
        row.issues.length > 0 ? (
          <span className="tabular-nums">{formatNumber(row.issues.length)}</span>
        ) : (
          <span className="text-muted-foreground">None found</span>
        ),
    },
    {
      key: 'evidence',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: 'page', page: row })}>
          Evidence
        </Button>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Technical run" />
        {/* A run belonging to another project resolves the same as a missing
            one, so a run id cannot be probed for existence (§4.1). */}
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!audit) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const failing = audit.findings.filter((f) => f.status === 'fail');
  const incomplete = audit.findings.filter((f) => f.status === 'error' || f.status === 'not-run');

  return (
    <div className="space-y-6">
      {/* §4 run/evidence detail: "sticky scope/run header". */}
      <ScopeBanner
        sticky
        scope={{
          projectName: 'This project',
          domain: audit.targetUrl,
          mode: 'live',
          runLabel: `Run ${audit.id}`,
        }}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/research/website/runs/${audit.id}/compare`}>
                Compare with previous
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/research/website`}>Back to website health</Link>
            </Button>
          </>
        }
      />

      <PageHeader
        title="Technical run"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{audit.targetUrl}</span>
            <span>
              Started <Timestamp value={audit.createdAt} />
            </span>
            <span>
              Triggered by <span className="font-mono">{audit.triggeredBy}</span>
            </span>
          </span>
        }
        status={<StatusPill label={`Score ${audit.score ?? notMeasuredLabel()}`} tone="neutral" />}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {/* The section index. A run detail is long by nature; this is the
          contract's "section index", as real anchors so keyboard users can
          jump without a script. */}
      <nav aria-label="Sections of this run" className="text-table">
        <ol className="flex flex-wrap gap-x-4 gap-y-1">
          <li>
            <a href="#status" className="text-primary underline-offset-4 hover:underline">
              Run status
            </a>
          </li>
          <li>
            <a href="#checks" className="text-primary underline-offset-4 hover:underline">
              Checks
            </a>
          </li>
          <li>
            <a href="#pages" className="text-primary underline-offset-4 hover:underline">
              Page inventory
            </a>
          </li>
          <li>
            <a href="#commentary" className="text-primary underline-offset-4 hover:underline">
              Commentary
            </a>
          </li>
        </ol>
      </nav>

      <div id="status">
        <RunStatusStrip
          run={{
            id: audit.id,
            status: audit.findings.length === 0 ? 'partial' : 'completed',
            startedAt: audit.createdAt,
          }}
          detail={
            <div className="space-y-1">
              <p>
                {audit.findings.length} checks recorded:{' '}
                {audit.findings.filter((f) => f.status === 'pass').length} passed, {failing.length} failed
                {incomplete.length > 0 ? `, ${incomplete.length} produced no result` : ''}.
              </p>
              {incomplete.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-5">
                  {incomplete.map((f) => (
                    <li key={f.id}>
                      <span className="font-medium text-foreground">{technicalCheckLabel(f.type)}</span> —{' '}
                      {findingReason(f)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          }
        >
          <div className="space-y-6">
            {coverage ? (
              <CoveragePanel
                summary={coverage}
                title="Check coverage for this run"
                contextNote={
                  audit.pagesCrawled > 0
                    ? `The per-page inventory below covers the ${formatNumber(audit.pagesCrawled)} sitemap URLs this run fetched.`
                    : undefined
                }
              />
            ) : null}

            <section id="checks" aria-labelledby="checks-heading" className="space-y-3">
              <Card>
                <CardHeader>
                  <CardTitle id="checks-heading" className="text-subsection">
                    Checks
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  {audit.findings.length === 0 ? (
                    <EmptyState
                      variant="not-measured"
                      subject="the individual checks"
                      prerequisite="this run recorded no check rows at all, which is different from every check passing."
                    />
                  ) : (
                    <DataTable
                      caption="Site-level checks and their results"
                      columns={findingColumns}
                      rows={audit.findings}
                      getRowId={(row) => row.id}
                      minTableWidth="64rem"
                      filters={[
                        {
                          id: 'status',
                          label: 'Result',
                          options: [
                            { value: 'pass', label: 'Passed' },
                            { value: 'fail', label: 'Failed' },
                            { value: 'error', label: 'Errored' },
                            { value: 'not-run', label: 'Not run' },
                          ],
                          getValue: (row) => row.status,
                        },
                        {
                          id: 'severity',
                          label: 'Severity',
                          options: [
                            { value: 'high', label: 'High' },
                            { value: 'medium', label: 'Medium' },
                            { value: 'low', label: 'Low' },
                          ],
                          getValue: (row) => row.severity,
                        },
                      ]}
                      emptyState={<EmptyState variant="no-results" />}
                    />
                  )}
                </CardContent>
              </Card>
            </section>

            <section id="pages" aria-labelledby="pages-heading" className="space-y-3">
              <Card>
                <CardHeader>
                  <CardTitle id="pages-heading" className="text-subsection">
                    Page inventory
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  {audit.pages.length === 0 ? (
                    <EmptyState
                      variant="not-measured"
                      subject="a per-page inventory"
                      prerequisite="the run's sitemap crawl must fetch at least one URL."
                    />
                  ) : (
                    <>
                      <DataTable
                        caption="Pages fetched by this run, worst score first"
                        columns={pageColumns}
                        rows={audit.pages}
                        getRowId={(row) => row.url}
                        defaultSort={{ key: 'score', direction: 'asc' }}
                        minTableWidth="64rem"
                        filters={[
                          {
                            id: 'issues',
                            label: 'Issues',
                            options: [
                              { value: 'with', label: 'Has issues' },
                              { value: 'without', label: 'No issues found' },
                            ],
                            getValue: (row) => (row.issues.length > 0 ? 'with' : 'without'),
                          },
                        ]}
                        emptyState={<EmptyState variant="no-results" />}
                      />
                      <p className="mt-2 text-meta text-muted-foreground">
                        Filters apply to the rows this endpoint returned, which is the whole inventory for
                        this run. Server-side pagination is not available yet (design_plan G14).
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>
            </section>

            <section id="commentary" aria-labelledby="commentary-heading">
              <Card>
                <CardHeader>
                  <CardTitle id="commentary-heading" className="flex flex-wrap items-center gap-2 text-subsection">
                    Commentary
                    <ProvenanceBadge kind="model-interpretation" />
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  {audit.narrative ? (
                    <div className="space-y-2">
                      {/* Model-authored prose. Rendered as text, never as markup
                          (§10.5), and never fed back into the score. */}
                      <p className="whitespace-pre-wrap text-body text-foreground">{audit.narrative}</p>
                      <p className="text-meta text-muted-foreground">
                        Written by <span className="font-mono">{audit.narrativeModel ?? 'an unrecorded model'}</span>
                        {audit.narrativeAt ? (
                          <>
                            {' '}
                            on <Timestamp value={audit.narrativeAt} />
                          </>
                        ) : null}
                        . This is a reading of the results above, not an additional measurement, and it does
                        not affect the score.
                      </p>
                    </div>
                  ) : (
                    <p className="text-table text-muted-foreground">
                      This run has no written commentary. The score is computed deterministically from the
                      checks above and does not depend on one.
                    </p>
                  )}
                </CardContent>
              </Card>
            </section>
          </div>
        </RunStatusStrip>
      </div>

      <EvidenceDrawer
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title={open?.kind === 'check' ? `Check: ${technicalCheckLabel(open.finding.type)}` : 'Page evidence'}
        source={
          open?.kind === 'check'
            ? {
                name: 'Technical audit run',
                capturedAt: audit.createdAt,
                runId: audit.id,
                url: audit.targetUrl,
                query: open.finding.reproductionCommands ?? undefined,
              }
            : {
                name: 'Page fetch by this run',
                capturedAt: open?.page.checkedAt ?? audit.createdAt,
                runId: audit.id,
                url: open?.page.url,
              }
        }
        observed={
          open?.kind === 'check' ? (
            <div className="space-y-1">
              <p>
                {technicalCheckLabel(open.finding.type)} returned{' '}
                <span className="font-medium">{checkStatusLabel(open.finding.status)}</span> with severity{' '}
                <span className="font-medium">{titleCase(open.finding.severity)}</span>.
              </p>
              <p>{findingReason(open.finding)}</p>
            </div>
          ) : open ? (
            <dl className="grid gap-1">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Fetch status</dt>
                <dd>{open.page.status > 0 ? open.page.status : 'The fetch threw'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Title</dt>
                <dd className="min-w-0 truncate text-right">{open.page.title ?? notMeasuredLabel()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Meta description</dt>
                <dd className="min-w-0 truncate text-right">{open.page.metaDescription ?? notMeasuredLabel()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">H1 count</dt>
                <dd>{open.page.h1Count ?? notMeasuredLabel()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Words</dt>
                <dd>{open.page.wordCount ?? notMeasuredLabel()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Images missing alt</dt>
                <dd>
                  {open.page.imagesMissingAlt ?? notMeasuredLabel()}
                  {open.page.imageCount !== null ? ` of ${open.page.imageCount}` : ''}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">JSON-LD</dt>
                <dd>
                  {open.page.jsonLdTypes.length > 0
                    ? open.page.jsonLdTypes.join(', ')
                    : 'No types found'}
                </dd>
              </div>
            </dl>
          ) : null
        }
        interpretation={
          open?.kind === 'check' ? (
            open.finding.recommendedFix
          ) : open ? (
            <p>
              Page score {open.page.score ?? notMeasuredLabel()} of 100, from the same disclosed per-page
              rubric applied to every URL in the run. Issues recorded:{' '}
              {open.page.issues.length > 0 ? open.page.issues.join(', ') : 'none'}.
            </p>
          ) : null
        }
        // The check's prescription and the page score are both computed by
        // Cailyx from the observation, not measured from the source directly.
        interpretationKind="derived"
        raw={
          open?.kind === 'check'
            ? { label: 'Raw check output', text: findingRawText(open.finding) }
            : open
              ? {
                  label: 'Raw page record',
                  text: JSON.stringify(
                    {
                      url: open.page.url,
                      status: open.page.status,
                      title: open.page.title,
                      titleLength: open.page.titleLength,
                      metaDescription: open.page.metaDescription,
                      metaDescLength: open.page.metaDescLength,
                      h1Count: open.page.h1Count,
                      canonical: open.page.canonical,
                      wordCount: open.page.wordCount,
                      jsonLdTypes: open.page.jsonLdTypes,
                      jsonLdValid: open.page.jsonLdValid,
                      jsonLdCount: open.page.jsonLdCount,
                      issues: open.page.issues,
                      score: open.page.score,
                    },
                    null,
                    2,
                  ),
                }
              : undefined
        }
        confidence={
          open?.kind === 'check'
            ? {
                level: open.finding.confidence === 'confirmed' ? 'high' : 'medium',
                basis:
                  open.finding.confidence === 'confirmed'
                    ? 'A direct probe returned this result.'
                    : 'Inferred from the response rather than observed directly.',
              }
            : undefined
        }
        provenance="measured"
        related={[{ label: `Run ${audit.id}`, href: `/projects/${projectId}/research/website/runs/${audit.id}`, kind: 'run' }]}
      />
    </div>
  );
}

function checkStatusLabel(status: string): string {
  switch (status) {
    case 'pass':
      return 'Passed';
    case 'fail':
      return 'Failed';
    case 'error':
      return 'Check errored';
    case 'not-run':
      return 'Not run';
    default:
      return status;
  }
}

function checkStatusTone(status: string): StatusTone {
  switch (status) {
    case 'pass':
      return 'success';
    case 'fail':
      return 'danger';
    // A check that never produced a verdict is not the same as a failing site.
    case 'error':
      return 'warning';
    case 'not-run':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}

function severityTone(severity: string): StatusTone {
  switch (severity) {
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    case 'low':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function confidenceLabel(confidence: string): string {
  switch (confidence) {
    case 'confirmed':
      return 'Confirmed directly';
    case 'inferred':
      return 'Inferred';
    default:
      return confidence;
  }
}

function titleCase(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
