'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  getPortalResultsTab,
  type OnlinePresenceTabData,
  type OverviewSection,
  type WebsiteTabData,
} from '@/services/overview';
import { WebsiteOrganicPanel } from '../../../results/tab-panels';

/**
 * Performance → Visibility → Organic (2026-09-21 client-nav restructure).
 *
 * Renders the Google-search half of the `website` Results tab, plus the
 * former standalone `presence` tab folded in below it — see
 * `navigation.ts`'s `CLIENT_PROJECT_NAV` doc comment for the reasoning
 * (presence has no top-level slot in the new tree, and "where you're
 * findable" reads as one Visibility question).
 */
export default function ClientPerformanceOrganicPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [website, setWebsite] = useState<OverviewSection<WebsiteTabData> | null>(null);
  const [presence, setPresence] = useState<OverviewSection<OnlinePresenceTabData> | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, websiteTab, presenceTab] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalResultsTab(projectId, 'website', { signal }),
          getPortalResultsTab(projectId, 'presence', { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setWebsite(websiteTab);
        setPresence(presenceTab);
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
        <PageHeader title="Organic" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || !website) {
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
          { label: 'Visibility: Organic' },
        ]}
        title="Organic visibility"
        context="What Google search is bringing in, and where else you're findable."
      />
      <WebsiteOrganicPanel websiteSection={website} presenceSection={presence} />
    </div>
  );
}
