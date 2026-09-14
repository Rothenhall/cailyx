'use client';

/**
 * /v3/rivals — Competitors workspace as its own route.
 * @module app/v3/rivals/page
 */

import { useRouter } from 'next/navigation';
import { useV3 } from '../_lib/SessionContext';
import { CompetitorsWorkspace } from '../_components/CompetitorsWorkspace';
import { ErrorBoundary } from '../_components/ErrorBoundary';

export default function RivalsPage() {
  const { session: c, notify } = useV3();
  const router = useRouter();

  if (!c.activeId) {
    return (
      <div className="v3-section p-6">
        <p className="text-body text-faint">Select a project to compare against rivals.</p>
      </div>
    );
  }

  return (
    <div className="v3-section">
      <ErrorBoundary label="Rivals">
        <CompetitorsWorkspace
          key={c.activeId}
          projectId={c.activeId}
          domain={c.project?.domain ?? null}
          onClose={() => router.push('/v3')}
          onNotify={notify}
        />
      </ErrorBoundary>
    </div>
  );
}
