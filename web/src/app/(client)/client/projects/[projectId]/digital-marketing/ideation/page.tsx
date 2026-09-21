'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { formatNumber } from '@/lib/format';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { listPortalOpportunities, OPPORTUNITY_ORIGIN_LABELS, type Opportunity } from '@/services/opportunities';

/**
 * Digital Marketing → Ideation (2026-09-21 client-nav restructure).
 *
 * A minimal, read-only view of the Ideas/Opportunities queue
 * (`listPortalOpportunities`, `GET /portal/projects/:projectId/opportunities`
 * — a new client-portal endpoint added alongside this page, see
 * `backend/src/modules/opportunities/opportunities.controller.ts`'s
 * `OpportunitiesPortalController`). Only non-dismissed ideas are shown by
 * default; there is no analyze/dismiss/reopen/convert control here — those
 * stay staff actions on the operator's `/content/opportunities` ("Ideas
 * workspace", `PROJECT_NAV`), unchanged.
 */
export default function ClientIdeationPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, result] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          listPortalOpportunities(projectId, { pageSize: 50 }, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setOpportunities(result.opportunities.filter((entry) => entry.status !== 'dismissed'));
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
        <PageHeader title="Ideation" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || !opportunities) {
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
          { label: 'Digital Marketing' },
          { label: 'Ideation' },
        ]}
        title="Ideation"
        context="Content and topic ideas your delivery team is tracking for you. Read-only for now."
      />

      {opportunities.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState variant="not-measured" subject="ideas for this project" prerequisite="None have been identified yet." />
          </CardContent>
        </Card>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {opportunities.map((opportunity) => (
            <li key={opportunity.id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-table font-medium">{opportunity.topicDisplay}</span>
                <StatusPill
                  label={opportunity.status === 'in-progress' ? 'In progress' : opportunity.status === 'converted' ? 'In your calendar' : 'New'}
                  tone={opportunity.status === 'converted' ? 'success' : opportunity.status === 'in-progress' ? 'warning' : 'neutral'}
                />
              </div>
              <p className="text-meta text-muted-foreground">
                {OPPORTUNITY_ORIGIN_LABELS[opportunity.origin]}
                {opportunity.market ? ` · ${opportunity.market}` : ''}
                {opportunity.demandVolume !== null ? ` · ~${formatNumber(opportunity.demandVolume)} searches/mo` : ''}
              </p>
              <p className="text-meta text-muted-foreground">{opportunity.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
