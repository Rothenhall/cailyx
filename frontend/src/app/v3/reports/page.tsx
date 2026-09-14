'use client';

/**
 * /v3/reports — Deliverables workspace (branded reports + scorecard) as its own route.
 * @module app/v3/reports/page
 */

import { useRouter } from 'next/navigation';
import { useV3 } from '../_lib/SessionContext';
import { DeliverablesWorkspace } from '../_components/DeliverablesWorkspace';
import { ErrorBoundary } from '../_components/ErrorBoundary';

export default function ReportsPage() {
  const { session: c, notify } = useV3();
  const router = useRouter();

  if (!c.activeId) {
    return (
      <div className="v3-section p-6">
        <p className="text-body text-faint">Select a project to see its deliverables.</p>
      </div>
    );
  }

  return (
    <div className="v3-section">
      <ErrorBoundary label="Deliverables">
        <DeliverablesWorkspace
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
