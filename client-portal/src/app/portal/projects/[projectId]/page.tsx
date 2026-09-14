'use client';

/**
 * Client project status page — mirrors the admin project page's shape
 * (status header + report history + embedded latest report) but scoped to
 * what a client can see: their own project, via /portal/* endpoints only.
 */

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { listPortalProjects, listPortalReports, getPortalReport } from '@/lib/endpoints';
import { TopBar } from '@/components/ui/TopBar';
import { Panel } from '@/components/ui/Panel';
import { OnboardingBadge, BandBadge } from '@/components/ui/Badge';
import { ReportView } from '@/components/report/ReportView';
import type { PortalProjectDto, PortalReportSummaryDto, ReportData } from '@/types/api';

export default function PortalProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const user = useRequireAuth('client');

  const [project, setProject] = useState<PortalProjectDto | null>(null);
  const [history, setHistory] = useState<PortalReportSummaryDto[] | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listPortalProjects(), listPortalReports()])
      .then(([p, r]) => {
        const proj = p.projects.find((x) => x.id === projectId) ?? null;
        const reports = r.reports.filter((x) => x.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setProject(proj);
        setHistory(reports);
        setSelectedSlug(reports[0]?.slug ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load project'));
  }, [projectId]);

  useEffect(() => {
    if (!selectedSlug) return;
    getPortalReport(selectedSlug)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load report'));
  }, [selectedSlug]);

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="portal" />
      <main className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        <Link href="/portal" className="text-caption text-faint hover:text-dim">
          ← Projects
        </Link>

        {error && <p className="text-body text-red">{error}</p>}
        {!project && !error && <div className="h-24 skeleton" />}

        {project && (
          <Panel>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-title font-medium">{project.name}</h1>
                <p className="truncate text-caption text-faint">{project.domain}</p>
              </div>
              <OnboardingBadge status={project.onboardingStatus} />
              <BandBadge band={project.latestBand} />
            </div>
            {project.onboardingStatus === 'running' && project.onboardingStep && (
              <p className="mt-2 text-caption text-faint">Currently running: {project.onboardingStep}</p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-ui sm:grid-cols-3">
              <div>
                <dt className="text-caption text-faint">Score</dt>
                <dd className="text-title font-semibold">{project.latestScore ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-caption text-faint">Reports</dt>
                <dd className="text-title font-semibold">{history?.length ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-caption text-faint">Last audit</dt>
                <dd className="text-ui">{project.lastAuditAt ? new Date(project.lastAuditAt).toLocaleDateString() : '—'}</dd>
              </div>
            </dl>
          </Panel>
        )}

        {history && history.length > 1 && (
          <Panel>
            <div className="flex flex-wrap gap-2">
              {history.map((r) => (
                <button
                  key={r.slug}
                  onClick={() => setSelectedSlug(r.slug)}
                  className={`rounded-r2 border px-3 py-1.5 text-caption transition-colors ${
                    r.slug === selectedSlug
                      ? 'border-accent-dim bg-accent-dim/10 font-medium text-accent'
                      : 'border-border text-faint hover:text-dim'
                  }`}
                >
                  {new Date(r.createdAt).toLocaleDateString()} · {r.scoreTotal}
                </button>
              ))}
            </div>
          </Panel>
        )}

        {project && history && history.length === 0 && (
          <Panel>
            <p className="text-body text-faint">
              No reports yet for this project
              {project.onboardingStatus === 'running' ? ' — your audit is still running.' : '.'}
            </p>
          </Panel>
        )}
        {!report && !error && project && history && history.length > 0 && <div className="h-64 skeleton" />}
        {report && <ReportView report={report} />}
      </main>
    </div>
  );
}
