'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, FileText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { listPortalReports, type PortalReportSummary } from '@/services/portal';

/**
 * CP11 — Reports.
 *
 * design_plan.md §4.5: "Cross-own-project reports, project/date filters,
 * summary/score, open."
 *
 * **"Own" is enforced by the server.** This page renders whatever
 * `/api/portal/reports` returns, which is scoped from the session — there is
 * no client filter to get wrong. §10.1 is explicit that route groups are not
 * authorization, so the page does not attempt any filtering of its own beyond
 * the presentation-level project filter below, which only narrows what the
 * server already allowed.
 *
 * The G05 release rule applies to this list: a report is only here because it
 * was released to this client. A private draft is never in this response, so
 * there is deliberately no "hidden" state to render.
 */
export default function ClientReportsPage() {
  const [reports, setReports] = useState<PortalReportSummary[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      setReports(await listPortalReports({ signal }));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" />
        <ErrorState error={error} onRetry={() => void load()} showServerMessage={false} />
      </div>
    );
  }

  if (!reports) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        context="Each report is a snapshot of its period. It is not updated afterwards."
      />

      {reports.length === 0 ? (
        // `runExists: false` — we have no evidence a run is in progress, and
        // §3.5 forbids the "being prepared" wording without one.
        <EmptyState variant="no-reports" runExists={false} />
      ) : (
        <div className="space-y-3">
          {reports.map((report) => (
            <Card key={report.id}>
              <CardContent className="flex items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate text-table font-medium">{report.title}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
                    <Timestamp value={report.createdAt} dateOnly />
                    {report.projectName ? <span>{report.projectName}</span> : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  {typeof report.scoreTotal === 'number' ? (
                    <span className="text-subsection font-semibold tabular-nums">
                      {report.scoreTotal}
                    </span>
                  ) : (
                    <span className="text-meta text-muted-foreground">Not scored</span>
                  )}
                  {report.scoreBand ? (
                    <StatusPill label={report.scoreBand} tone="neutral" />
                  ) : null}
                  <Link
                    href={`/client/reports/${report.slug}`}
                    className="inline-flex items-center gap-1 text-table text-primary underline-offset-4 hover:underline"
                  >
                    Open
                    <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
