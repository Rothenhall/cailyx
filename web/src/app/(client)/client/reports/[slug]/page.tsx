'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { FileQuestion, MessageSquare, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import { getPortalReport } from '@/services/portal';
import type { ReportData } from '@/services/reports';

/**
 * CP12 — Report reader.
 *
 * design_plan.md §4.5: *"Client-scoped JSON rendered as executive/detail view,
 * print, ask about report."*
 *
 * The page is built around one sentence from §6.4 and §3.3: **a report is a
 * frozen snapshot**. It was assembled from whatever runs existed when it was
 * generated, generation deliberately does not trigger new runs, and later runs
 * do not change it. `ScopeBanner` therefore runs in `snapshot` mode — the loud
 * one — so a reader cannot mistake these figures for current data, and the
 * banner deliberately survives to paper when the report is printed.
 *
 * The second rule is that **an absent section is absent, not empty**.
 * `growthPlan`, `backlinks`, `presence` and `competitors` are `null` when their
 * source run has never happened. Each one renders a line naming the prerequisite
 * that would produce it — never a zero, and never an empty table that reads as
 * "we looked and found nothing".
 *
 * The payload is JSON rendered as text. It is never injected as markup: §10.5
 * forbids treating fetched content as trusted application HTML, and the
 * executive summary is model-authored prose.
 */
const TAB_DEFAULTS = { tab: 'executive' };

export default function ClientReportReaderPage() {
  // `useSearchParams` (through `useUrlState`) forces a client-side bailout
  // during prerendering, so the URL-reading part sits behind its own boundary.
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <ReportReaderScreen />
    </Suspense>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function ReportReaderScreen() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [view, setView] = useUrlState(TAB_DEFAULTS);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setReport(await getPortalReport(slug, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [slug],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Report" />
        {/* §4.1 — a missing report and another client's report read identically,
            so this cannot probe for slugs. */}
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!report) {
    return <ReportSkeleton />;
  }

  const optionalSections: Array<{
    key: string;
    title: string;
    prerequisite: string;
    value: Record<string, unknown> | null;
  }> = [
    { key: 'growth', title: 'Growth roadmap', prerequisite: 'the strategy build or a findings pass', value: report.growthPlan },
    { key: 'backlinks', title: 'Backlinks', prerequisite: 'a backlinks refresh', value: report.backlinks },
    { key: 'presence', title: 'Digital presence', prerequisite: 'a presence discovery run', value: report.presence },
    { key: 'competitors', title: 'Competitors', prerequisite: 'tracked competitors', value: report.competitors },
  ];

  return (
    <div className="space-y-6">
      {/*
        Snapshot mode, unmistakably: the label, the warning tone and the
        sentence saying later runs do not change these figures. It is not
        `no-print` — a printed report must carry this context too.
      */}
      <ScopeBanner
        scope={{
          projectName: report.title,
          domain: report.targetUrl,
          mode: 'snapshot',
          snapshotLabel: `Report generated ${formatIso(report.createdAt)}`,
        }}
        actions={
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer aria-hidden="true" className="mr-2 h-4 w-4" />
            Print
          </Button>
        }
      />

      <PageHeader
        breadcrumbs={[{ label: 'Reports', href: '/client/reports' }, { label: report.title }]}
        title={report.title}
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{report.targetUrl}</span>
            <span>
              Generated <Timestamp value={report.createdAt} />
            </span>
          </span>
        }
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href="/client/messages">
              <MessageSquare aria-hidden="true" className="mr-2 h-4 w-4" />
              Ask about this report
            </Link>
          </Button>
        }
      />

      <Tabs
        value={view.tab === 'detail' ? 'detail' : 'executive'}
        onValueChange={(value) => setView({ tab: value })}
      >
        <TabsList>
          <TabsTrigger value="executive">Executive view</TabsTrigger>
          <TabsTrigger value="detail">Full detail</TabsTrigger>
        </TabsList>

        {/* ── Executive view ─────────────────────────────────────────── */}
        <TabsContent value="executive" className="space-y-4">
          <Card>
            <CardContent className="flex flex-wrap items-center gap-6 py-6">
              <div>
                <div className="text-meta text-muted-foreground">Overall score</div>
                <div className="mt-1 text-kpi font-semibold tabular-nums">
                  {typeof report.scoreTotal === 'number' ? formatNumber(report.scoreTotal) : 'Not measured yet'}
                </div>
              </div>
              <Separator orientation="vertical" className="h-12" />
              <div>
                <div className="text-meta text-muted-foreground">Band</div>
                <div className="mt-1 text-subsection font-medium">
                  {report.scoreBand || 'Not reported'}
                </div>
              </div>
              <Separator orientation="vertical" className="h-12" />
              <div>
                <div className="text-meta text-muted-foreground">Sub-scores</div>
                <div className="mt-1 text-subsection font-medium tabular-nums">
                  {report.subScores.length}
                </div>
              </div>
            </CardContent>
          </Card>

          {report.executiveSummary ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">Executive summary</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Model-authored prose, rendered as text — never as markup. */}
                <div className="whitespace-pre-wrap text-body leading-relaxed">
                  {report.executiveSummary}
                </div>
                <p className="mt-4 text-meta text-muted-foreground">
                  This summary is written by Cailyx, not measured. The figures it
                  refers to are in the detail view.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-4">
                <EmptyState
                  variant="not-measured"
                  subject="the executive summary"
                  prerequisite="No summary was written when this report was generated."
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Sub-scores</CardTitle>
            </CardHeader>
            <CardContent>
              {report.subScores.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="sub-scores"
                  prerequisite="Sub-scores appear when the scoring rubric has run against this project."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {report.subScores.map((entry, index) => (
                    <li
                      key={entry.key ?? index}
                      className="flex items-center justify-between gap-4 py-2"
                    >
                      <span className="text-table">
                        {entry.label ?? entry.key ?? `Dimension ${index + 1}`}
                      </span>
                      <span className="text-table font-semibold tabular-nums">
                        {typeof entry.score === 'number' ? formatNumber(entry.score) : 'Not measured yet'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Full detail ────────────────────────────────────────────── */}
        <TabsContent value="detail" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Findings</CardTitle>
            </CardHeader>
            <CardContent>
              {report.findings.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="findings"
                  prerequisite="Findings are written from the gap analysis; a report generated before that ran has none."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {report.findings.map((finding, index) => (
                    <li key={index} className="space-y-1 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-table font-medium">{finding.label}</span>
                        {typeof finding.severity === 'string' ? (
                          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-meta text-muted-foreground">
                            {finding.severity}
                          </span>
                        ) : null}
                        {typeof finding.status === 'string' ? (
                          <span className="text-meta text-muted-foreground">{finding.status}</span>
                        ) : null}
                      </div>
                      <div className="text-meta text-muted-foreground">
                        {humanize(finding.type)}
                        {typeof finding.confidence === 'string' ? ` · confidence: ${finding.confidence}` : ''}
                      </div>
                      {typeof finding.recommendedFix === 'string' && finding.recommendedFix ? (
                        <p className="text-table">{finding.recommendedFix}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Recommended actions</CardTitle>
            </CardHeader>
            <CardContent>
              {report.roadmap.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="the roadmap"
                  prerequisite="The roadmap is built from the strategy pass; a report generated before it ran has none."
                />
              ) : (
                <ol className="divide-y divide-border">
                  {report.roadmap.map((entry, index) => (
                    <li key={index} className="space-y-1 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-table font-medium">
                          {typeof entry.title === 'string' && entry.title
                            ? entry.title
                            : `Action ${index + 1}`}
                        </span>
                        {typeof entry.priorityScore === 'number' ? (
                          <span className="text-meta text-muted-foreground">
                            Priority score {formatNumber(entry.priorityScore)}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-meta text-muted-foreground">
                        {typeof entry.dimension === 'string' ? humanize(entry.dimension) : null}
                        {typeof entry.severity === 'string' && entry.severity
                          ? ` · ${entry.severity}`
                          : ''}
                        {typeof entry.status === 'string' ? ` · ${humanize(entry.status)}` : ''}
                      </div>
                      {typeof entry.description === 'string' && entry.description ? (
                        <p className="whitespace-pre-wrap text-table">{entry.description}</p>
                      ) : null}
                      {typeof entry.action === 'string' && entry.action ? (
                        <p className="text-table text-muted-foreground">{entry.action}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          {optionalSections.map((section) => (
            <Card key={section.key}>
              <CardHeader>
                <CardTitle className="text-subsection">{section.title}</CardTitle>
              </CardHeader>
              <CardContent>
                {section.value !== null ? (
                  <details open>
                    <summary className="cursor-pointer text-meta text-muted-foreground">
                      Record as captured
                    </summary>
                    <pre className="evidence mt-2">{JSON.stringify(section.value, null, 2)}</pre>
                  </details>
                ) : (
                  // A null section is a source that never ran, not an empty result.
                  <p className="text-table text-muted-foreground">
                    This section is not part of this report. It is included when{' '}
                    {section.prerequisite} has run for the project before the
                    report was generated — report generation reads what exists
                    and does not start new work.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <Card>
        <CardContent className="space-y-1 py-4 text-table">
          <p className="flex items-start gap-2">
            <FileQuestion aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              This report is a snapshot taken when it was generated. Running new
              audits does not change it — a newer report is a separate document
              with its own date.
            </span>
          </p>
          <p className="text-meta text-muted-foreground">
            Questions about a figure belong in{' '}
            <Link href="/client/messages" className="text-primary underline underline-offset-4">
              messages
            </Link>
            , where your delivery team can point at the run behind it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function humanize(value: string): string {
  if (!value) return 'Finding';
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ');
}

function formatIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'at an unreadable date';
  return date.toLocaleDateString();
}
