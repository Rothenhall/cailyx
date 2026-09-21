'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, FileText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { listPortalProjectSummaries, listPortalReports, type PortalProjectSummary, type PortalReportSummary } from '@/services/portal';

/**
 * Reports, project-scoped (2026-09-21 client-nav restructure).
 *
 * `GET /portal/reports` (CP11's `listPortalReports`) is account-wide — "own"
 * is enforced by the server, there is no client filter to get wrong (see that
 * page's own doc comment at `client/reports/page.tsx`). This screen reuses
 * the exact same read and narrows it to this project client-side, which is
 * the smallest change that matches the new per-project nav position: each
 * `PortalReportSummary` already carries an optional `projectId`, so no new
 * endpoint or query param was needed. The account-wide `/client/reports`
 * screen is untouched and stays for a client who wants every project's
 * reports in one list.
 */
export default function ClientProjectReportsPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [reports, setReports] = useState<PortalReportSummary[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, allReports] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          listPortalReports({ signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setReports(allReports.filter((report) => report.projectId === projectId));
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

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || !reports) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />
      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Reports' },
        ]}
        title="Reports"
        context="Each report is a snapshot of its period. It is not updated afterwards."
      />

      {reports.length === 0 ? (
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
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  {typeof report.scoreTotal === 'number' ? (
                    <span className="text-subsection font-semibold tabular-nums">{report.scoreTotal}</span>
                  ) : (
                    <span className="text-meta text-muted-foreground">Not scored</span>
                  )}
                  {report.scoreBand ? <StatusPill label={report.scoreBand} tone="neutral" /> : null}
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

      <p className="text-meta text-muted-foreground">
        Looking for every project&apos;s reports in one list?{' '}
        <Link href="/client/reports" className="text-primary underline underline-offset-4">
          See all your reports
        </Link>
        .
      </p>
    </div>
  );
}
