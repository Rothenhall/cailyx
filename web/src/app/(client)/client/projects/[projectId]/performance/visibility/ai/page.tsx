'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { getPortalResultsTab, type AiVisibilityTabData, type OverviewSection } from '@/services/overview';
import { ResultsTabPanel } from '../../../results/tab-panels';

/**
 * Performance → Visibility → AI (2026-09-21 client-nav restructure).
 *
 * Unchanged content — this is the `ai` Results tab at its new address, reused
 * wholesale via `ResultsTabPanel` (the same component the old `/results`
 * screen renders it with).
 */
export default function ClientPerformanceAiVisibilityPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [section, setSection] = useState<OverviewSection<AiVisibilityTabData> | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, tab] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalResultsTab(projectId, 'ai', { signal }),
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
        <PageHeader title="AI visibility" />
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
          { label: 'Performance', href: `/client/projects/${projectId}/performance` },
          { label: 'Visibility: AI' },
        ]}
        title="AI visibility"
        context="Where do AI answer engines mention you, and where do they not?"
      />
      <ResultsTabPanel tab="ai" section={section} />
    </div>
  );
}
