'use client';

/**
 * /v3/audits/[discipline] — Technical, SEO or AEO, picked by URL segment
 * instead of AuditsSection's local `useState`. Competitors and Keywords are
 * NOT tabs here — they moved to their own top-level routes (/v3/rivals,
 * /v3/keywords) since the nav rail already reaches them, and a workspace
 * reachable two ways is exactly the "three navigation models" debt the /v3
 * rebuild set out to remove.
 *
 * @module app/v3/audits/[discipline]/page
 */

import { use, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useV3 } from '../../_lib/SessionContext';
import { TechnicalAuditWorkspace } from '../../_components/TechnicalAuditWorkspace';
import { SeoAuditWorkspace } from '../../_components/SeoAuditWorkspace';
import { AeoAuditWorkspace } from '../../_components/AeoAuditWorkspace';
import { ErrorBoundary } from '../../_components/ErrorBoundary';

type Discipline = 'technical' | 'seo' | 'aeo';
const DISCIPLINES: { id: Discipline; label: string; blurb: string }[] = [
  { id: 'technical', label: 'Technical', blurb: 'Crawl, access, performance, stack' },
  { id: 'seo', label: 'SEO', blurb: 'Search Console queries and pages' },
  { id: 'aeo', label: 'AEO', blurb: 'Answer-engine visibility across engines' },
];

export default function AuditDisciplinePage({ params }: { params: Promise<{ discipline: string }> }) {
  const { discipline } = use(params);
  const { session: c, notify } = useV3();
  const router = useRouter();

  const valid = DISCIPLINES.some((d) => d.id === discipline);
  useEffect(() => {
    if (!valid) router.replace('/v3/audits/technical');
  }, [valid, router]);

  if (!c.activeId) {
    return (
      <div className="v3-section p-6">
        <p className="text-body text-faint">Select a project to run an audit.</p>
      </div>
    );
  }
  if (!valid) return null;

  const which = discipline as Discipline;

  return (
    <div className="v3-section">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5">
        {DISCIPLINES.map((d) => (
          <Link
            key={d.id}
            href={`/v3/audits/${d.id}`}
            title={d.blurb}
            className={`rounded-r2 px-2.5 py-1 text-caption transition-colors ${
              which === d.id ? 'bg-bg-inset font-semibold text-text' : 'text-faint hover:text-dim'
            }`}
          >
            {d.label}
          </Link>
        ))}
        <span className="ml-auto truncate text-caption text-faint">{c.project?.domain ?? '—'}</span>
      </div>

      <div className="relative min-h-0 flex-1">
        {which === 'technical' && (
          <ErrorBoundary label="Technical audit">
            <TechnicalAuditWorkspace
              key={`tech-${c.activeId}`}
              projectId={c.activeId}
              domain={c.project?.domain ?? null}
              onClose={() => router.push('/v3')}
              onNotify={notify}
            />
          </ErrorBoundary>
        )}
        {which === 'seo' && (
          <ErrorBoundary label="SEO audit">
            <SeoAuditWorkspace
              key={`seo-${c.activeId}`}
              projectId={c.activeId}
              domain={c.project?.domain ?? null}
              onClose={() => router.push('/v3')}
              onNotify={notify}
            />
          </ErrorBoundary>
        )}
        {which === 'aeo' && (
          <ErrorBoundary label="AEO audit">
            <AeoAuditWorkspace
              key={`aeo-${c.activeId}`}
              projectId={c.activeId}
              domain={c.project?.domain ?? null}
              onClose={() => router.push('/v3')}
              onNotify={notify}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
