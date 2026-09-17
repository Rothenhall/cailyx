'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, Suspense, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { FileQuestion, MessageSquare, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FrozenPlanProgressSection, FrozenScoreSection } from '@/components/patterns/FrozenReportSections';
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
 * ## P15 — where the live figure and this figure are told apart
 *
 * The reader is served by the release gate — `getPortalReport` reads the
 * frozen `ReportRevision.snapshot`, never the mutable `Report` row — so
 * `releasedLabel` — *"As released in the September report"* — travels with the
 * data and is rendered above every frozen figure. The live screen's
 * counterpart is *"Live score, updated <date>"*, and the two sentences exist
 * precisely so two similar-looking numbers are never confusable. The score
 * family and the plan progress are rendered from
 * `@/components/patterns/FrozenReportSections`, which reads the snapshot's own
 * copy: a later live-score update, and a new draft revision, both leave this
 * page byte-for-byte what it said on release day (§14.6).
 *
 * The second rule is that **an absent section is absent, not empty**.
 * `growthPlan`, `backlinks`, `presence` and `competitors` are `null` when their
 * source run has never happened, and the frozen P15 sections are `null` on a
 * revision released before they existed. Each one renders a line naming the
 * prerequisite that would produce it — never a zero, and never an empty table
 * that reads as "we looked and found nothing".
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
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
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
    { key: 'growth', title: 'Growth plan', prerequisite: 'the strategy build or a findings pass', value: report.growthPlan },
    { key: 'backlinks', title: 'Backlinks', prerequisite: 'a backlink check', value: report.backlinks },
    { key: 'presence', title: 'Online presence', prerequisite: 'an online presence check', value: report.presence },
    { key: 'competitors', title: 'Competitors', prerequisite: 'tracked competitors', value: report.competitors },
  ];

  /**
   * §14.6's label, derived from the same field the release gate wrote
   * (`releasedAt`) rather than from "now": a report released in September keeps
   * saying September however long afterwards it is read. The label is part of
   * the freeze, not a rendering flourish.
   */
  const releasedLabel = `As released in the ${monthName(
    report.releasedAt ?? report.snapshotAt ?? report.createdAt,
  )} report`;
  const liveResultsHref = `/client/projects/${report.projectId}/results`;

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
            <CardContent className="border-t border-border pt-3 text-meta text-muted-foreground">
              {/* The live/report distinction on the headline number itself: the
                  reader should not have to reach the section below to learn
                  that this figure is the released one. */}
              {releasedLabel} — the live score on your results page may have moved since.
            </CardContent>
          </Card>

          {/*
            P15 — the frozen score family. `undefined` means this route does not
            serve the section at all; `null` means the revision predates it, and
            the component says so in words rather than showing zeros.
          */}
          {report.digitalPerformance !== undefined ? (
            <FrozenScoreSection
              section={report.digitalPerformance}
              releasedLabel={releasedLabel}
              liveHref={liveResultsHref}
              liveNote="the current figure, which does change as new checks finish"
            />
          ) : null}

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
                  prerequisite="Sub-scores appear once the score has been calculated for this project."
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

          {/* P15 — the frozen 30-day plan progress, same freeze discipline. */}
          {report.planProgress !== undefined ? (
            <FrozenPlanProgressSection section={report.planProgress} releasedLabel={releasedLabel} />
          ) : null}
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
                  prerequisite="Findings are written from the website and content review; a report generated before that ran has none."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {report.findings.map((finding, index) => (
                    <li key={index} className="space-y-1 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-table font-medium">{finding.label}</span>
                        {typeof finding.severity === 'string' && finding.severity ? (
                          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-meta text-muted-foreground">
                            {plainTerm(finding.severity)}
                          </span>
                        ) : null}
                        {typeof finding.status === 'string' && finding.status ? (
                          <span className="text-meta text-muted-foreground">{plainTerm(finding.status)}</span>
                        ) : null}
                      </div>
                      <div className="text-meta text-muted-foreground">
                        {plainTerm(finding.type)}
                        {typeof finding.confidence === 'string' && finding.confidence
                          ? ` · confidence: ${plainTerm(finding.confidence)}`
                          : ''}
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
                  subject="the 30-day plan"
                  prerequisite="The 30-day plan is built from the strategy pass; a report generated before it ran has none."
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
                            Priority {formatNumber(entry.priorityScore)}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-meta text-muted-foreground">
                        {typeof entry.dimension === 'string' ? plainTerm(entry.dimension) : null}
                        {typeof entry.severity === 'string' && entry.severity
                          ? ` · ${plainTerm(entry.severity)}`
                          : ''}
                        {typeof entry.status === 'string' && entry.status
                          ? ` · ${plainTerm(entry.status)}`
                          : ''}
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
                  /* §4.3: normal client screens never render raw JSON, raw
                     statuses or internal record IDs, so the section is
                     rendered as the same business facts the staff view shows
                     — humanised keys and values, with id/hash/key fields
                     dropped. Staff can still read the stored record itself
                     from the run's own screen. */
                  <div>
                    <p className="text-meta text-muted-foreground">What this section recorded</p>
                    <SectionFacts value={section.value} />
                  </div>
                ) : (
                  // A null section is a source that never ran, not an empty result.
                  <p className="text-table text-muted-foreground">
                    This section is not part of this report. It is included when{' '}
                    {section.prerequisite} has happened for the project before
                    the report was generated — a report reads what exists and
                    does not start new work.
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
              This report is a snapshot taken when it was generated. Running a new
              check does not change it — a newer report is a separate document
              with its own date.
            </span>
          </p>
          <p className="text-meta text-muted-foreground">
            Questions about a figure belong in{' '}
            <Link href="/client/messages" className="text-primary underline underline-offset-4">
              messages
            </Link>
            , where your delivery team can point at the measurement behind it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * §4.3 dictionary, applied to values that arrive from a stored record. A raw
 * enum or slug ("gap", "sleeper", "methodology-break") is internal vocabulary;
 * the reader gets the client-facing words instead. Unknown values fall back to
 * a de-slugged, sentence-cased form rather than being hidden.
 */
const PLAIN_TERMS: Record<string, string> = {
  gap: 'Opportunity',
  gaps: 'Opportunities',
  intervention: 'Improvement',
  'methodology-break': 'Results are not directly comparable',
  'no-baseline': 'No earlier period to compare',
  sleeper: 'Update existing content',
  refresh: 'Update',
  candidate: 'Needs confirmation',
  unverified: 'Found; not fully checked',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'For information',
  warning: 'Needs attention',
  critical: 'Needs attention now',
  open: 'Open',
  resolved: 'Resolved',
  dismissed: 'Set aside',
  pending: 'Waiting',
  'in-progress': 'In progress',
  done: 'Finished',
};

function plainTerm(value: string): string {
  const key = value.trim().toLowerCase();
  if (PLAIN_TERMS[key]) return PLAIN_TERMS[key];
  return humanize(key);
}

/** Fields that identify a record rather than describe it (§4.3). */
const RECORD_ID_FIELD = /(^|[_-])(id|hash|key|token|checksum)$|Id$|Hash$/;

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function renderFactValue(value: unknown): ReactNode {
  if (isPrimitive(value)) {
    return typeof value === 'string' ? plainTermIfSlug(value) : String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.filter(isPrimitive).map((entry) => (typeof entry === 'string' ? plainTermIfSlug(entry) : String(entry)));
    if (parts.length === 0) return `${value.length} entries recorded`;
    return parts.join(', ');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([key]) => !RECORD_ID_FIELD.test(key));
    if (entries.length === 0) return 'Recorded';
    return entries
      .map(([key, nested]) => `${humanize(key)}: ${isPrimitive(nested) ? String(nested) : 'recorded'}`)
      .join(' · ');
  }
  return 'Not recorded';
}

/** A slug-shaped string is dictionary-mapped; prose passes through untouched. */
function plainTermIfSlug(value: string): string {
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value) ? plainTerm(value) : value;
}

/**
 * §4.3-safe rendering of a stored report section: named facts, no JSON, no
 * record identifiers, and never a silently empty block — an object whose every
 * field is an identifier says so in words.
 */
function SectionFacts({ value }: { value: unknown }) {
  if (isPrimitive(value)) {
    return <p className="mt-1 text-table text-foreground">{renderFactValue(value)}</p>;
  }
  if (Array.isArray(value)) {
    const rows = value.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return <p className="mt-1 text-table text-foreground">{renderFactValue(value)}</p>;
    }
    return (
      <dl className="mt-1 divide-y divide-border">
        {rows.map((row, index) => (
          <div key={index} className="py-2">
            {Object.entries(row)
              .filter(([key]) => !RECORD_ID_FIELD.test(key))
              .map(([key, nested]) => (
                <div key={key} className="flex flex-wrap items-baseline gap-x-2 text-table">
                  <dt className="text-meta text-muted-foreground">{humanize(key)}</dt>
                  <dd className="text-foreground">{renderFactValue(nested)}</dd>
                </div>
              ))}
          </div>
        ))}
      </dl>
    );
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([key]) => !RECORD_ID_FIELD.test(key));
    if (entries.length === 0) {
      return (
        <p className="mt-1 text-table text-muted-foreground">
          This section was recorded, but its contents are identifiers only — nothing here is a business fact to
          show. Ask your delivery team if you need the underlying record.
        </p>
      );
    }
    return (
      <dl className="mt-1 space-y-1">
        {entries.map(([key, nested]) => (
          <div key={key} className="flex flex-wrap items-baseline gap-x-2 text-table">
            <dt className="text-meta text-muted-foreground">{humanize(key)}</dt>
            <dd className="text-foreground">{renderFactValue(nested)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <p className="mt-1 text-table text-muted-foreground">Not recorded.</p>;
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

/**
 * The month name used by §14.6's release label ("September"), matching the
 * server's own `monthLabel` for the Overview's report panel. An unreadable
 * date must not become "Invalid Date report", so it degrades to a phrase the
 * sentence can still carry.
 */
function monthName(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an earlier';
  return date.toLocaleDateString('en-US', { month: 'long' });
}
