'use client';

/**
 * Admin project status page — the real "how is this project doing" view.
 * Onboarding state, the latest report embedded inline (score, subscores,
 * findings, roadmap, growth plan, backlinks — everything ReportView shows),
 * and a history of every report ever generated for this project so an
 * operator can see progress over time, not just the newest snapshot.
 */

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { getClient, getReport, listReportsForProject } from '@/lib/endpoints';
import { TopBar } from '@/components/ui/TopBar';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { OnboardingBadge, BandBadge } from '@/components/ui/Badge';
import { ReportView } from '@/components/report/ReportView';
import type { ClientDetailDto, ClientProjectSummaryDto, ReportData, ReportSummaryDto } from '@/types/api';

export default function AdminProjectPage({
  params,
}: {
  params: Promise<{ clientId: string; projectId: string }>;
}) {
  const { clientId, projectId } = use(params);
  const user = useRequireAuth('operator');

  const [client, setClient] = useState<ClientDetailDto | null>(null);
  const [history, setHistory] = useState<ReportSummaryDto[] | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const project: ClientProjectSummaryDto | undefined = client?.projects.find((p) => p.id === projectId);

  useEffect(() => {
    Promise.all([getClient(clientId), listReportsForProject(projectId)])
      .then(([c, r]) => {
        setClient(c);
        setHistory(r.reports);
        const p = c.projects.find((x) => x.id === projectId);
        setSelectedSlug(p?.latestReportSlug ?? r.reports[0]?.slug ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load project'));
  }, [clientId, projectId]);

  useEffect(() => {
    if (!selectedSlug) return;
    getReport(projectId, selectedSlug)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load report'));
  }, [projectId, selectedSlug]);

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="admin" />
      <main className="mx-auto max-w-4xl space-y-4 px-5 py-6">
        <Link href={`/admin/clients/${clientId}`} className="text-caption text-faint hover:text-dim">
          ← {client?.name ?? 'Client'}
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
            {project.onboardingStatus === 'failed' && project.onboardingError && (
              <p className="mt-2 rounded-r2 border border-red/30 bg-red/5 px-3 py-2 text-caption text-red">
                {project.onboardingError}
              </p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-ui sm:grid-cols-4">
              <div>
                <dt className="text-caption text-faint">Score</dt>
                <dd className="text-title font-semibold">{project.latestScore ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-caption text-faint">Open gaps</dt>
                <dd className="text-title font-semibold">{project.openGapCount}</dd>
              </div>
              <div>
                <dt className="text-caption text-faint">Reports</dt>
                <dd className="text-title font-semibold">{history?.length ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-caption text-faint">Created</dt>
                <dd className="text-ui">{new Date(project.createdAt).toLocaleDateString()}</dd>
              </div>
            </dl>
          </Panel>
        )}

        {history && history.length > 1 && (
          <Panel>
            <PanelHeader title="Report history" />
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
              {project.onboardingStatus === 'pending'
                ? ' — onboarding hasn’t started.'
                : project.onboardingStatus === 'running'
                  ? ' — the Day-1 pipeline is still running.'
                  : '.'}
            </p>
          </Panel>
        )}
        {!report && !error && project && history && history.length > 0 && <div className="h-64 skeleton" />}
        {report && <ReportView report={report} />}
      </main>
    </div>
  );
}
