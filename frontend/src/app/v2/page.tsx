'use client';

/**
 * /v2 — the Cailyx operator console. A fixed three-band canvas: the Flywheel
 * welded to the left wall, the Analytics card floating between, the Agents Feed
 * (with the Cailyx Assistant beneath it) on the right, and the Context drawer
 * welded to the right wall.
 *
 * All data comes from the live backend through `useConsole`; the header actions
 * open one grouped <SettingsPanel>. Requires a session — unauthenticated hits
 * bounce to /login.
 *
 * @module app/v2/page
 */

import { useState } from 'react';
import './v2.css';
import { useConsole } from './_lib/useConsole';
import { TopBar } from './_components/TopBar';
import { ContextPanel, CONTEXT_NUB_W } from './_components/ContextPanel';
import { AgentsFeed } from './_components/AgentsFeed';
import { Analytics } from './_components/Analytics';
import { ChatBot, type ChatSeed } from './_components/ChatBot';
import { Flywheel, FLYWHEEL_VB } from './_components/Flywheel';
import { ErrorBoundary } from './_components/ErrorBoundary';
import { SettingsPanel } from './_components/SettingsPanel';
import { NewProjectModal } from './_components/NewProjectModal';
import { ToastStack, useToasts } from './_components/Toasts';
import { API_URL } from '@/lib/api';

export default function V2Console() {
  const c = useConsole();
  const { toasts, notify, dismiss } = useToasts();

  const [panel, setPanel] = useState<'connections' | 'users' | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [seed, setSeed] = useState<ChatSeed | null>(null);

  /* the id monotonically increases so handing over the same text twice still
     registers as a new event on the chat side */
  const handOff = (kind: ChatSeed['kind'], text: string) =>
    setSeed((s) => ({ id: (s?.id ?? 0) + 1, kind, text }));

  if (c.fatal) {
    return (
      <div className="v2 grid min-h-screen place-items-center p-6 text-center font-sans">
        <div>
          <p className="font-display text-display text-danger">{c.fatal}</p>
          <p className="mt-2 text-body text-faint">Is the backend running on {API_URL}?</p>
        </div>
      </div>
    );
  }

  const integrations = c.integrations?.integrations ?? [];

  return (
    /* `.v2` scopes the whole design system — the type scale, radius and motion
       ladders, the status ramp — so none of it leaks into the v1 console */
    <div className="v2 flex h-screen flex-col overflow-hidden font-sans">
      <TopBar
        user={c.user}
        projects={c.projects}
        activeId={c.activeId}
        onSelect={c.selectProject}
        onNewProject={() => setNewProject(true)}
        onLogout={c.logout}
        onOpenConnections={() => setPanel('connections')}
        onOpenUsers={() => setPanel('users')}
        connectedCount={c.integrations?.summary.connected ?? null}
      />

      {/* Left band reserved for the wall-mounted Flywheel / Context; the rest is
          the Agents Feed — its grid panel carries the Cailyx Assistant, so the
          chat slides away and back together with the agent grid.

          The gutters come from the wall components' own constants (see the
          .v2-canvas rules in v2.css), so they can't drift out of sync. */}
      <main
        className="v2-dots v2-canvas relative grid min-h-0 flex-1"
        style={{
          ['--wheel-half' as string]: `${FLYWHEEL_VB / 2}px`,
          ['--nub' as string]: `${CONTEXT_NUB_W}px`,
        }}
      >
        <ErrorBoundary label="The flywheel">
          <Flywheel
            wheel={c.wheel}
            loading={c.booting || c.wheelLoading || c.projectPending}
            onPick={(q) => handOff('query', q)}
          />
        </ErrorBoundary>

        <ErrorBoundary label="The context drawer">
          <ContextPanel project={c.project} agents={c.agents} onSave={c.saveProject} />
        </ErrorBoundary>

        {/* Analytics card, parked between the Flywheel's visible half and the feed */}
        <section className="v2-analytics pointer-events-none flex min-h-0 items-center justify-center py-6">
          <ErrorBoundary label="Analytics">
            <Analytics
              key={c.activeId ?? 'none'}
              projectId={c.activeId}
              domain={c.project?.domain ?? null}
              integrations={integrations}
              booting={c.booting}
              onOpenConnections={() => setPanel('connections')}
              onNotify={notify}
            />
          </ErrorBoundary>
        </section>

        <section className="v2-feed flex min-h-0 flex-col py-6">
          <ErrorBoundary label="The agents feed">
            <AgentsFeed
              data={c.agents}
              loading={c.booting || c.agentsLoading || c.projectPending}
              onRefresh={c.refreshAgents}
              onAsk={(key) => handOff('agent', key)}
              chat={
                <ChatBot
                  project={c.project}
                  agents={c.agents}
                  integrations={integrations}
                  seed={seed}
                  onOpenConnections={() => setPanel('connections')}
                />
              }
            />
          </ErrorBoundary>
        </section>
      </main>

      <SettingsPanel
        open={panel}
        onClose={() => setPanel(null)}
        user={c.user}
        integrations={integrations}
        onRecheck={c.refreshIntegrations}
        onNotify={notify}
      />

      {(newProject || c.needsFirstProject) && (
        <NewProjectModal
          dismissable={!c.needsFirstProject}
          onClose={() => setNewProject(false)}
          onCreate={async (input) => {
            const p = await c.addProject(input);
            setNewProject(false);
            notify(`${p.domain} created`);
          }}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
