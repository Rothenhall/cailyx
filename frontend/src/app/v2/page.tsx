'use client';

/**
 * /v2 — the Cailyx operator console. A fixed three-band canvas: the Flywheel
 * welded to the left wall, the Audits card floating between, the Agents Feed
 * (with the Cailyx Assistant beneath it) on the right, and the Context drawer
 * welded to the right wall.
 *
 * All data comes from the live backend through `useConsole`; the header actions
 * open one grouped <SettingsPanel>. Requires a session — unauthenticated hits
 * bounce to /login.
 *
 * @module app/v2/page
 */

import { useEffect, useState } from 'react';
import './v2.css';
import { useConsole } from './_lib/useConsole';
import { TopBar } from './_components/TopBar';
import { ContextPanel, CONTEXT_NUB_W } from './_components/ContextPanel';
import { AgentsFeed } from './_components/AgentsFeed';
import { Audits } from './_components/Audits';
import { TechnicalAuditWorkspace } from './_components/TechnicalAuditWorkspace';
import { SeoAuditWorkspace } from './_components/SeoAuditWorkspace';
import { ChatBot, type ChatSeed } from './_components/ChatBot';
import { Flywheel, FLYWHEEL_VB } from './_components/Flywheel';
import { ErrorBoundary } from './_components/ErrorBoundary';
import { HIDDEN_INTEGRATIONS, SettingsPanel } from './_components/SettingsPanel';
import { NewProjectModal } from './_components/NewProjectModal';
import { ToastStack, useToasts } from './_components/Toasts';
import { CommandPalette, type Command } from './_components/CommandPalette';
import { AgentIcon, LogoutIcon, PlugIcon, PlusIcon, SyncIcon, UsersIcon } from './_components/icons';
import { listGoogleConnections } from '@/lib/terminal-api';
import { API_URL } from '@/lib/api';

export default function V2Console() {
  const c = useConsole();
  const { toasts, notify, dismiss } = useToasts();

  const [panel, setPanel] = useState<'connections' | 'users' | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [seed, setSeed] = useState<ChatSeed | null>(null);
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  /* the Technical tile takes over the canvas rather than opening in-card */
  const [expanded, setExpanded] = useState<'technical' | 'seo' | null>(null);
  /* live Google (GSC + GA) connections — folded into the header count */
  const [googleConnected, setGoogleConnected] = useState<number | null>(null);
  const refreshGoogle = () =>
    listGoogleConnections()
      .then((rows) => setGoogleConnected(rows.filter((r) => r.connected && !r.expired).length))
      .catch(() => setGoogleConnected(0));
  useEffect(() => {
    void refreshGoogle();
  }, []);

  /* ⌘K / Ctrl-K opens the palette from anywhere */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* The Google OAuth popup posts its result back here (and, on the same-tab
     fallback path, lands with ?google=… in the URL). Either way: toast the
     outcome and refresh the connection state. */
  useEffect(() => {
    const settle = (g: string, status: string | null, reason: string | null) => {
      if (g === 'error' || status === 'error') {
        notify(`Google connect failed: ${reason ?? 'unknown error'}`, 'warn');
      } else {
        notify(`${g === 'analytics' ? 'Google Analytics' : 'Search Console'} connected`);
        void c.refreshIntegrations();
        void refreshGoogle();
        setPanel('connections');
      }
    };

    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.source === 'cailyx-google-oauth') settle(d.google, d.status ?? null, d.reason ?? null);
    };
    window.addEventListener('message', onMsg);

    const p = new URLSearchParams(window.location.search);
    const g = p.get('google');
    if (g) {
      settle(g, p.get('status'), p.get('reason'));
      window.history.replaceState({}, '', window.location.pathname);
    }
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  /* Hidden integrations are filtered here rather than at the render sites, so
     the header's connected badge counts the same set the operator can open. */
  const integrations = (c.integrations?.integrations ?? []).filter(
    (i) => !HIDDEN_INTEGRATIONS.has(i.key),
  );

  const commands: Command[] = [
    ...(c.agents?.agents ?? []).map((a) => ({
      id: `agent:${a.key}`,
      label: a.name,
      group: 'Agents' as const,
      keywords: `${a.key} ${a.category} ${a.headline}`,
      hint: a.status,
      icon: <AgentIcon agentKey={a.key} size={16} />,
      run: () => setAgentKey(a.key),
    })),
    ...c.projects.map((p) => ({
      id: `project:${p.id}`,
      label: p.domain,
      group: 'Projects' as const,
      keywords: `${p.name} switch`,
      hint: p.id === c.activeId ? 'current' : undefined,
      icon: <PlusIcon className="h-4 w-4" />,
      run: () => c.selectProject(p.id),
    })),
    {
      id: 'w:connections',
      label: 'Connections & setup gates',
      group: 'Workspace' as const,
      keywords: 'integrations keys api',
      icon: <PlugIcon className="h-4 w-4" />,
      run: () => setPanel('connections'),
    },
    ...(c.user?.role === 'admin'
      ? [
          {
            id: 'w:team',
            label: 'Team',
            group: 'Workspace' as const,
            keywords: 'users operators roles',
            icon: <UsersIcon className="h-4 w-4" />,
            run: () => setPanel('users'),
          } as Command,
        ]
      : []),
    {
      id: 'w:new',
      label: 'New project',
      group: 'Workspace' as const,
      keywords: 'create add domain',
      icon: <PlusIcon className="h-4 w-4" />,
      run: () => setNewProject(true),
    },
    {
      id: 'w:refresh',
      label: 'Refresh agents',
      group: 'Workspace' as const,
      keywords: 'reload poll',
      icon: <SyncIcon className="h-4 w-4" />,
      run: () => c.refreshAgents(),
    },
    {
      id: 'w:logout',
      label: 'Log out',
      group: 'Workspace' as const,
      keywords: 'sign out exit',
      icon: <LogoutIcon className="h-4 w-4" />,
      run: () => c.logout(),
    },
  ];

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
        onOpenPalette={() => setPalette(true)}
        connectedCount={
          c.integrations
            ? integrations.filter((i) => i.connected).length + (googleConnected ?? 0)
            : null
        }
      />

      {/* Left band reserved for the wall-mounted Flywheel / Context; the rest is
          the Agents Feed — its grid panel carries the Cailyx Assistant, so the
          chat slides away and back together with the agent grid.

          The gutters come from the wall components' own constants (see the
          .v2-canvas rules in v2.css), so they can't drift out of sync. */}
      <main
        className={`v2-dots v2-canvas relative grid min-h-0 flex-1${expanded ? ' is-zoomed' : ''}`}
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

        {/* Audits card, parked between the Flywheel's visible half and the feed */}
        <section className="v2-audits pointer-events-none flex min-h-0 items-center justify-center py-6">
          <ErrorBoundary label="Audits">
            <Audits
              key={c.activeId ?? 'none'}
              projectId={c.activeId}
              domain={c.project?.domain ?? null}
              booting={c.booting}
              onNotify={notify}
              onExpand={(t) => setExpanded(t === 'seo' ? 'seo' : 'technical')}
            />
          </ErrorBoundary>
        </section>

        <section className="v2-feed flex min-h-0 flex-col py-6">
          <ErrorBoundary label="The agents feed">
            <AgentsFeed
              data={c.agents}
              loading={c.booting || c.agentsLoading || c.projectPending}
              projectId={c.activeId}
              runCtx={{ integrations, querySets: c.querySets }}
              selectedKey={agentKey}
              onSelect={setAgentKey}
              onRefresh={c.refreshAgents}
              onAsk={(key) => handOff('agent', key)}
              onRan={(key, error) => {
                if (error) {
                  notify(error, 'warn');
                  return;
                }
                // the roster is the source of truth for what a run produced,
                // so report from the refreshed card rather than guessing
                void c.refreshAgentsAnd((next) => {
                  const a = next.agents.find((x) => x.key === key);
                  notify(a ? `${a.name}: ${a.headline}` : 'run complete');
                });
              }}
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

        {expanded === 'technical' && (
          <ErrorBoundary label="Technical audit">
            <TechnicalAuditWorkspace
              key={c.activeId ?? 'none'}
              projectId={c.activeId}
              domain={c.project?.domain ?? null}
              onClose={() => setExpanded(null)}
              onNotify={notify}
            />
          </ErrorBoundary>
        )}

        {expanded === 'seo' && (
          <ErrorBoundary label="SEO audit">
            <SeoAuditWorkspace
              key={c.activeId ?? 'none'}
              projectId={c.activeId}
              domain={c.project?.domain ?? null}
              onClose={() => setExpanded(null)}
              onNotify={notify}
            />
          </ErrorBoundary>
        )}
      </main>

      <SettingsPanel
        open={panel}
        onClose={() => setPanel(null)}
        user={c.user}
        integrations={integrations}
        activeProject={c.activeId ? { id: c.activeId, domain: c.project?.domain ?? c.activeId } : null}
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

      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
