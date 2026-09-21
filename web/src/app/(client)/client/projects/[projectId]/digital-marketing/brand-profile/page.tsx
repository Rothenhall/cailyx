'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { AsOf } from '@/components/patterns/AsOf';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { getPortalBusinessProfile, type PortalBusinessProfileResponse } from '@/services/portal-profile';

/**
 * Digital Marketing → Brand Profile (2026-09-21 client-nav restructure).
 *
 * A read-only summary of the same confirmed/draft business profile Business
 * Information reads and edits (`getPortalBusinessProfile`, already existed
 * before this change — no new backend endpoint was needed). This page does
 * not duplicate Business Information's edit UI: it shows the marketing-
 * relevant subset (brand name, description, ICP, competitors) and links out
 * to Business Information for any correction, so there is exactly one place
 * a client edits these facts.
 */
export default function ClientBrandProfilePage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [profile, setProfile] = useState<PortalBusinessProfileResponse | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, profileResult] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalBusinessProfile(projectId, {}, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setProfile(profileResult);
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
        <PageHeader title="Brand Profile" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || !profile) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  const data = profile.profile?.data ?? null;

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />
      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Digital Marketing' },
          { label: 'Brand Profile' },
        ]}
        title="Brand Profile"
        context="How we describe you across content, ideas, and search. Read-only here — corrections go through Business Information."
        status={
          profile.profile ? (
            <StatusPill
              label={profile.profile.isDraft ? 'Draft — not yet confirmed' : 'Confirmed'}
              tone={profile.profile.isDraft ? 'warning' : 'success'}
            />
          ) : undefined
        }
      />

      {!data ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="your brand profile"
              prerequisite={profile.unavailableReason ?? 'Nothing has been recorded yet.'}
              action={{ label: 'Fill it in on Business Information', href: `/client/projects/${projectId}/business-info` }}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Overview</CardTitle>
            {/* C6 §28 — when these facts were last confirmed (or last edited, for a draft). */}
            <AsOf
              value={profile.profile?.confirmedAt ?? profile.profile?.updatedAt}
              label={profile.profile?.confirmedAt ? 'Confirmed as of' : 'Draft as of'}
            />
          </CardHeader>
          <CardContent className="space-y-4 pt-2">
            <Field label="Brand name" value={data.brandName} />
            <Field label="Description" value={data.description} />
            <Field label="Services" value={data.services.length > 0 ? data.services.join(', ') : null} />
            <Field
              label="Who you help"
              value={data.icp.segments && data.icp.segments.length > 0 ? data.icp.segments.join(', ') : null}
            />
            <Field
              label="Competitors"
              value={data.competitors.length > 0 ? data.competitors.map((c) => c.name).join(', ') : null}
            />
          </CardContent>
        </Card>
      )}

      <p className="text-meta text-muted-foreground">
        To correct any of this, go to{' '}
        <Link href={`/client/projects/${projectId}/business-info`} className="text-primary underline underline-offset-4">
          Business Information
        </Link>
        .
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-meta text-muted-foreground">{label}</p>
      <p className="text-table">{value && value.trim().length > 0 ? value : 'Not set'}</p>
    </div>
  );
}
