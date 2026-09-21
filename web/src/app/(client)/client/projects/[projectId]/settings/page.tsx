'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { onboardingStatusTone } from '@/lib/status-tones';
import { StatusPill } from '@/components/patterns/StatusPill';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';

/**
 * Settings (2026-09-21 client-nav restructure) — genuinely new, deliberately
 * small.
 *
 * There is no existing client-facing settings surface and no client-
 * appropriate notification-preferences data to read yet (the operator's
 * `/settings` under `PROJECT_NAV` is project admin: metadata, lifecycle,
 * domain identity, client association, delete — all operator-only, nothing
 * client-appropriate to reuse). This page is project/account basics
 * (read-only: name, domain, setup status) rather than an invented settings
 * area. If real client-editable settings (e.g. notification preferences)
 * ship later, this is where they'd go.
 */
export default function ClientProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const projects = await listPortalProjectSummaries({ signal });
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
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
        <PageHeader title="Settings" />
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
          { label: 'Settings' },
        ]}
        title="Settings"
        context="The basics for this project."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <div>
            <p className="text-meta text-muted-foreground">Name</p>
            <p className="text-table">{project.name}</p>
          </div>
          <div>
            <p className="text-meta text-muted-foreground">Domain</p>
            <p className="text-table font-mono">{project.domain ?? 'Not set'}</p>
          </div>
          <div>
            <p className="text-meta text-muted-foreground">Setup status</p>
            <StatusPill
              label={project.onboardingStatus ?? 'Not reported'}
              tone={project.onboardingStatus ? onboardingStatusTone(project.onboardingStatus) : 'unmeasured'}
            />
          </div>
        </CardContent>
      </Card>

      <p className="text-meta text-muted-foreground">
        Notification preferences and other settings will appear here as they become available.
      </p>
    </div>
  );
}
