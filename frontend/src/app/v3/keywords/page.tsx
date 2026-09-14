'use client';

/**
 * /v3/keywords — Keyword research workspace as its own route.
 * @module app/v3/keywords/page
 */

import { useRouter } from 'next/navigation';
import { useV3 } from '../_lib/SessionContext';
import { KeywordsWorkspace } from '../_components/KeywordsWorkspace';
import { ErrorBoundary } from '../_components/ErrorBoundary';

export default function KeywordsPage() {
  const { session: c, notify } = useV3();
  const router = useRouter();

  if (!c.activeId) {
    return (
      <div className="v3-section p-6">
        <p className="text-body text-faint">Select a project to research keywords.</p>
      </div>
    );
  }

  return (
    <div className="v3-section">
      <ErrorBoundary label="Keywords">
        <KeywordsWorkspace key={c.activeId} projectId={c.activeId} onClose={() => router.push('/v3')} onNotify={notify} />
      </ErrorBoundary>
    </div>
  );
}
