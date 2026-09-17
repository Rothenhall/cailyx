'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { ActionQueueList } from '@/components/patterns/ActionQueueList';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { getPortalActions, type PortalActionQueue } from '@/services/portal-plan';

/**
 * The full "needs your action" queue (§5.6, §16.2 S02) — the screen behind
 * Overview's three cards.
 *
 * Overview shows at most three of these by design; this is where the rest live,
 * so "View all" leads somewhere that actually lists all of them rather than at
 * a related-but-different screen.
 *
 * Deliberately not in the primary project navigation (§3.2: put "Needs your
 * action" in Overview and the global work inbox rather than adding another
 * overlapping primary navigation label). It is reached from Overview.
 *
 * Every row is derived server-side from the record that raised it — an
 * approval, an onboarding request — so an item disappears when its source is
 * resolved, not when it is read. There is no completion control here for that
 * reason.
 */
export default function ClientActionsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [queue, setQueue] = useState<PortalActionQueue | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, actions] = await Promise.allSettled([
          listPortalProjectSummaries({ signal }),
          getPortalActions(projectId, { signal }),
        ]);
        if (projects.status === 'rejected') throw projects.reason;
        setProject(projects.value.find((entry) => entry.id === projectId) ?? null);
        if (actions.status === 'fulfilled') setQueue(actions.value);
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
        <PageHeader title="What we need from you" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || queue === null) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
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
          { label: 'What we need from you' },
        ]}
        title="What we need from you"
        context="Everything waiting on you right now. Opening an item doesn’t close it — we’ll take it off this list once it’s actually done."
      />

      <Card>
        <CardContent className="pt-6">
          <ActionQueueList
            items={queue.items}
            total={queue.total}
            emptyCopy="You’re all caught up. We’ll let you know when we need something."
          />
        </CardContent>
      </Card>
    </div>
  );
}
