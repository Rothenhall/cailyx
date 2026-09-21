'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { ScoreSummary } from '@/components/patterns/ScoreSummary';
import { formatNumber } from '@/lib/format';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { getPortalOverview, getPortalResultsTab, type PortalOverviewView } from '@/services/overview';

/**
 * Performance → Overview (2026-09-21 client-nav restructure).
 *
 * New: a thin landing page for the Performance area, summarizing across
 * Technical / Visibility (Organic, AI) / Competitors and linking onward. It
 * does not re-implement any of those screens' content — it fetches the same
 * composed score the project Dashboard shows (`getPortalOverview`) plus one
 * headline figure per destination, purely for orientation.
 */
export default function ClientPerformanceOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [overview, setOverview] = useState<PortalOverviewView | null>(null);
  const [headlines, setHeadlines] = useState<{
    technical: string | null;
    organic: string | null;
    ai: string | null;
    competitors: string | null;
  } | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, overviewResult] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getPortalOverview(projectId, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setOverview(overviewResult);

        // Best-effort headline figures. Each tab is fetched independently and
        // a failure degrades only its own headline (never the page) — the
        // same §4.5 rule the Results tabs themselves follow.
        const [website, ai, competitors] = await Promise.allSettled([
          getPortalResultsTab(projectId, 'website', { signal }),
          getPortalResultsTab(projectId, 'ai', { signal }),
          getPortalResultsTab(projectId, 'competitors', { signal }),
        ]);

        setHeadlines({
          technical:
            website.status === 'fulfilled' && website.value.data
              ? `${website.value.data.health.issueCount} ${website.value.data.health.issueCount === 1 ? 'issue' : 'issues'} found — ${website.value.data.health.label}`
              : null,
          organic:
            website.status === 'fulfilled' && website.value.data
              ? website.value.data.google.clicks !== null
                ? `${formatNumber(website.value.data.google.clicks)} clicks from Google`
                : 'Not measured yet'
              : null,
          ai:
            ai.status === 'fulfilled' && ai.value.data
              ? `Mentioned in ${ai.value.data.appeared.count} of ${ai.value.data.appeared.of} answers`
              : null,
          competitors:
            competitors.status === 'fulfilled' && competitors.value.data
              ? `${competitors.value.data.competitors.length} tracked`
              : null,
        });
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
        <PageHeader title="Performance" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  const cards: Array<{ label: string; href: string; headline: string | null }> = [
    { label: 'Technical', href: `/client/projects/${projectId}/performance/technical`, headline: headlines?.technical ?? null },
    { label: 'Visibility: Organic', href: `/client/projects/${projectId}/performance/visibility/organic`, headline: headlines?.organic ?? null },
    { label: 'Visibility: AI', href: `/client/projects/${projectId}/performance/visibility/ai`, headline: headlines?.ai ?? null },
    { label: 'Competitors', href: `/client/projects/${projectId}/competitors`, headline: headlines?.competitors ?? null },
  ];

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />
      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Performance' },
        ]}
        title="Performance"
        context="Your overall score, then one line each on your site health, your search and AI visibility, and how you compare to competitors."
      />

      <ScoreSummary section={overview?.sections.score} projectId={projectId} audience="client" />

      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <Link key={card.href} href={card.href} className="block">
            <Card className="transition-colors hover:border-primary">
              <CardContent className="flex items-center justify-between gap-3 py-4">
                <div>
                  <p className="text-table font-medium">{card.label}</p>
                  <p className="text-meta text-muted-foreground">
                    {headlines === null ? <Skeleton className="mt-1 h-4 w-40" /> : (card.headline ?? 'Not measured yet')}
                  </p>
                </div>
                <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
