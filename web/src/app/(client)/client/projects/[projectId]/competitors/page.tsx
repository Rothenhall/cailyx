'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { getPortalResultsTab, type CompetitorsTabData, type OverviewSection } from '@/services/overview';
import { ResultsTabPanel } from '../results/tab-panels';

/**
 * Competitors (2026-09-21 client-nav restructure) — promoted from a
 * Performance sub-item to its own top-level destination, per the product
 * owner's spec. Content is the `competitors` Results tab, unchanged, reused
 * wholesale via `ResultsTabPanel`.
 */
export default function ClientCompetitorsPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [section, setSection] = useState<OverviewSection<CompetitorsTabData> | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, tab] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalResultsTab(projectId, 'competitors', { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setSection(tab);
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
        <PageHeader title="Competitors" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
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
          { label: 'Competitors' },
        ]}
        title="Competitors"
        context="How do you compare with the businesses we track alongside you?"
      />
      <ResultsTabPanel tab="competitors" section={section} />
    </div>
  );
}
