'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber } from '@/lib/format';
import { getReport, type ReportData } from '@/services/reports';

/**
 * RP03 — Report reader.
 *
 * design_plan.md §4.4: *"Executive/detailed/evidence tabs, section index,
 * share/print, source limitations."*
 *
 * Two rules shape this page, both from §6.4's "empty ≠ zero" family and the
 * scope-banner contract:
 *
 *  1. **A report is a frozen snapshot.** It was assembled from whatever runs
 *     existed at generation time, and generation deliberately does not trigger
 *     new runs. The `ScopeBanner` runs in `snapshot` mode so a reader can never
 *     mistake these figures for live data, and the page states plainly that
 *     later runs do not change it.
 *  2. **A null section is absent, not empty.** `growthPlan`, `backlinks`,
 *     `presence` and `competitors` are null when their source run has never
 *     happened. Each renders an explicit "not part of this report" line naming
 *     the prerequisite — never a zero, and never an empty table that reads as
 *     "we looked and found nothing".
 *
 * Reading width is capped at 920 px per §3.1, which is why this page asks the
 * shell for the `reading` content width.
 */
export default function ReportReaderPage() {
  const params = useParams<{ projectId: string; slug: string }>();
  const { projectId, slug } = params;

  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setReport(await getReport(projectId, slug, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, slug],
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
        {/* §4.1 — a report that is missing and one that is another project's
            read identically, so this cannot probe for slugs. */}
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: report.title,
          domain: report.targetUrl,
          mode: 'snapshot',
          snapshotLabel: `Report generated ${new Date(report.createdAt).toLocaleDateString()}`,
        }}
      />

      <PageHeader
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
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer aria-hidden="true" className="mr-2 h-4 w-4" />
            Print
          </Button>
        }
      />

      {/* Score + band. Both are present on a generated report, so no
          "not measured" branch is needed here. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-6 py-6">
          <div>
            <div className="text-meta text-muted-foreground">Overall score</div>
            <div className="mt-1 text-kpi font-semibold tabular-nums">
              {formatNumber(report.scoreTotal)}
            </div>
          </div>
          <Separator orientation="vertical" className="h-12" />
          <div>
            <div className="text-meta text-muted-foreground">Band</div>
            <div className="mt-1 text-subsection font-medium">{report.scoreBand}</div>
          </div>
          {/* D11 — which rubric and which score run produced the number above.
              Null is rendered as unrecorded, never inferred from "the project's
              latest run": that would be a guess about provenance (§6.4). */}
          <Separator orientation="vertical" className="h-12" />
          <div>
            <div className="text-meta text-muted-foreground">Scored by</div>
            <div className="mt-1 text-table">
              {report.rubricVersion == null ? (
                <span className="text-unmeasured-foreground">Rubric version not recorded</span>
              ) : (
                <span className="font-medium">Rubric v{report.rubricVersion}</span>
              )}
            </div>
            <div className="mt-0.5 font-mono text-meta text-muted-foreground">
              {report.scoreRunId ?? 'Score run not recorded'}
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
            {/* Model-authored prose. Rendered as text, never as markup —
                §10.5 forbids injecting generated content as trusted HTML. */}
            <div className="whitespace-pre-wrap text-body leading-relaxed">
              {report.executiveSummary}
            </div>
          </CardContent>
        </Card>
      ) : null}

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
                  key={(entry.key as string) ?? index}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <span className="text-table">
                    {(entry.label as string) ?? (entry.key as string) ?? `Dimension ${index + 1}`}
                  </span>
                  <span className="text-table font-semibold tabular-nums">
                    {typeof entry.score === 'number' ? formatNumber(entry.score) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/*
        The four optional sections. Each states its prerequisite when absent,
        per §3.5 — a missing section is a missing source, not an empty result.
      */}
      <OptionalSection
        title="Growth roadmap"
        present={report.growthPlan !== null}
        prerequisite="the strategy build or findings pass"
      >
        <pre className="evidence">{JSON.stringify(report.growthPlan, null, 2)}</pre>
      </OptionalSection>

      <OptionalSection
        title="Backlinks"
        present={report.backlinks !== null}
        prerequisite="a backlinks refresh"
      >
        <pre className="evidence">{JSON.stringify(report.backlinks, null, 2)}</pre>
      </OptionalSection>

      <OptionalSection
        title="Digital presence"
        present={report.presence !== null}
        prerequisite="a presence discovery run"
      >
        <pre className="evidence">{JSON.stringify(report.presence, null, 2)}</pre>
      </OptionalSection>

      <OptionalSection
        title="Competitors"
        present={report.competitors !== null}
        prerequisite="tracked competitors"
      >
        <pre className="evidence">{JSON.stringify(report.competitors, null, 2)}</pre>
      </OptionalSection>

      <p className="text-meta text-muted-foreground">
        This report is a snapshot taken at generation time. Running new audits
        does not change it — a newer report is a separate document.
      </p>
    </div>
  );
}

/**
 * A section that may legitimately be absent from a snapshot.
 *
 * The absence copy names the prerequisite rather than saying "no data",
 * because the reader's next action differs: they need a run to happen, not a
 * filter cleared.
 */
function OptionalSection({
  title,
  present,
  prerequisite,
  children,
}: {
  title: string;
  present: boolean;
  prerequisite: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {present ? (
          children
        ) : (
          <p className="text-table text-muted-foreground">
            This section is not part of this report. It is included when {prerequisite}{' '}
            has run for the project before the report was generated.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
