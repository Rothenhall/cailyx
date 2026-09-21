'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AsOf } from '@/components/patterns/AsOf';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import {
  FORMALITY_LABELS,
  getPortalWritingStyle,
  type Formality,
  type WritingStyleProfile,
} from '@/services/writing-style';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';

/**
 * Digital Marketing → Brand Voice (2026-09-21 client-nav restructure).
 *
 * Read-only, matching the operator side's own §13.8 rule that client-edit
 * rights for writing style were never confirmed by product: this page calls
 * `getPortalWritingStyle`, which already existed (`GET
 * /portal/projects/:projectId/writing-style`) before this change — no new
 * backend endpoint was needed. Editing stays a staff action on
 * `/content/writing-style` (`PROJECT_NAV`, unchanged).
 */
export default function ClientBrandVoicePage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [style, setStyle] = useState<WritingStyleProfile | null | undefined>(undefined);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, styleResult] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalWritingStyle(projectId, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setStyle(styleResult);
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
        <PageHeader title="Brand Voice" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || style === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-56 rounded-xl" />
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
          { label: 'Brand Voice' },
        ]}
        title="Brand Voice"
        context="The tone and vocabulary content is written in for you. Read-only — your delivery team maintains this."
      />

      {!style ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="a confirmed writing style"
              prerequisite="No style has been confirmed for this project yet."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">{style.name}</CardTitle>
            {/* C6 §28 — when this writing style was confirmed (or created, if never confirmed). */}
            <AsOf
              value={style.confirmedAt ?? style.createdAt}
              label={style.confirmedAt ? 'Confirmed as of' : 'Created'}
            />
          </CardHeader>
          <CardContent className="space-y-4 pt-2">
            {style.summary ? (
              <div>
                <p className="text-meta text-muted-foreground">Summary</p>
                <p className="text-table">{style.summary}</p>
              </div>
            ) : null}
            <div>
              <p className="text-meta text-muted-foreground">Tone</p>
              <p className="text-table">{style.tone ?? 'Not set'}</p>
            </div>
            <div>
              <p className="text-meta text-muted-foreground">Formality</p>
              <p className="text-table">{FORMALITY_LABELS[style.formality as Formality] ?? style.formality}</p>
            </div>
            {style.audience ? (
              <div>
                <p className="text-meta text-muted-foreground">Audience</p>
                <p className="text-table">{style.audience}</p>
              </div>
            ) : null}
            {style.preferredWords.length > 0 ? (
              <div>
                <p className="text-meta text-muted-foreground">Preferred words</p>
                <p className="text-table">{style.preferredWords.join(', ')}</p>
              </div>
            ) : null}
            {style.avoidWords.length > 0 ? (
              <div>
                <p className="text-meta text-muted-foreground">Words to avoid</p>
                <p className="text-table">{style.avoidWords.join(', ')}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
