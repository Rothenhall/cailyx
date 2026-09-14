'use client';

/**
 * /v3/presence — Digital presence workspace as its own route.
 * @module app/v3/presence/page
 */

import { useRouter } from 'next/navigation';
import { useV3 } from '../_lib/SessionContext';
import { DigitalPresenceWorkspace } from '../_components/DigitalPresenceWorkspace';
import { ErrorBoundary } from '../_components/ErrorBoundary';

export default function PresencePage() {
  const { session: c, notify } = useV3();
  const router = useRouter();

  if (!c.activeId) {
    return (
      <div className="v3-section p-6">
        <p className="text-body text-faint">Select a project to see its digital presence.</p>
      </div>
    );
  }

  return (
    <div className="v3-section">
      <ErrorBoundary label="Digital presence">
        <DigitalPresenceWorkspace
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
