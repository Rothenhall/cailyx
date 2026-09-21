'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { getPortalResultsTab, type OverviewSection, type WebsiteTabData } from '@/services/overview';
import { WebsiteTechnicalPanel } from '../../results/tab-panels';

/**
 * Performance → Technical (2026-09-21 client-nav restructure).
 *
 * Renders the site-health half of the `website` Results tab
 * (`@/services/overview`'s `getPortalResultsTab(projectId, 'website')`), split
 * out by `WebsiteTechnicalPanel` in `results/tab-panels.tsx`. The Google-
 * search half of the same tab moved to Performance → Visibility → Organic —
 * see `navigation.ts`'s `CLIENT_PROJECT_NAV` doc comment for why the one
 * payload now has two pages.
 */
export default function ClientPerformanceTechnicalPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [section, setSection] = useState<OverviewSection<WebsiteTabData> | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, tab] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalResultsTab(projectId, 'website', { signal }),
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
        <PageHeader title="Technical" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || !section) {
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
          { label: 'Technical' },
        ]}
        title="Technical"
        context="Is your site healthy? Crawl issues, page health, and the pages that matter most."
      />
      <WebsiteTechnicalPanel section={section} />
    </div>
  );
}
