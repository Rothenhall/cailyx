'use client';

/**
 * /v3/agents — Agent reports (read view of swarm-layer output) as its own route.
 * @module app/v3/agents/page
 */

import { useRouter } from 'next/navigation';
import { useV3 } from '../_lib/SessionContext';
import { AgentReports } from '../_components/AgentReports';
import { ErrorBoundary } from '../_components/ErrorBoundary';

export default function AgentsPage() {
  const { session: c, notify } = useV3();
  const router = useRouter();

  if (!c.activeId) {
    return (
      <div className="v3-section p-6">
        <p className="text-body text-faint">Select a project to read agent output.</p>
      </div>
    );
  }

  return (
    <div className="v3-section">
      <ErrorBoundary label="Agent reports">
        <AgentReports
          key={c.activeId}
          projectId={c.activeId}
          agents={c.agents}
          onClose={() => router.push('/v3')}
          onNotify={notify}
        />
      </ErrorBoundary>
    </div>
  );
}
