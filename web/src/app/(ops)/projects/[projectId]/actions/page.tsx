'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ActionQueueList } from '@/components/patterns/ActionQueueList';
import { getStaffActions, type ActionQueue } from '@/services/delivery-plan';

/**
 * The full needs-your-action queue for one project (§5.6, §16.2 S02) — the
 * screen behind the Overview's three cards.
 *
 * Staff-scoped, which is a different queue from the client's: this one carries
 * the caller's own assigned review and verification tasks, delivery blockers,
 * and operator-reviewer approval requests assigned to them (or unassigned,
 * which any admin or delivery lead may pick up). It is scoped to the caller's
 * actor id server-side — this is not a portfolio view, and the server does not
 * trust a client-supplied scope.
 *
 * Not a primary navigation item (§3.2 keeps "Needs your action" in Overview
 * rather than adding an overlapping label). Reached from Overview.
 */
export default function ProjectActionsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setQueue(await getStaffActions(projectId, { signal }));
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
        <PageHeader title="Needs your attention" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (queue === null) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Needs your attention' },
        ]}
        title="Needs your attention"
        context="Work assigned to you or waiting on the team, derived from the records that actually hold it. An item leaves this list when its source is resolved, not when it is opened."
      />

      <Card>
        <CardContent className="pt-6">
          <ActionQueueList
            items={queue.items}
            total={queue.total}
            emptyCopy="Nothing is waiting on you or on the team for this project."
          />
        </CardContent>
      </Card>
    </div>
  );
}
