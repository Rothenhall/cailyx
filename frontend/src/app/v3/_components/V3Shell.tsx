'use client';

/**
 * V3Shell — the chrome shared by every /v3 route: Sidebar (nav + project
 * switcher + account), Topbar, the settings/new-project/command-palette
 * overlays, and the toast stack. A normal two-column dashboard shell —
 * sidebar left, topbar + routed content right — replacing /v2's full-width
 * TopBar + icon-rail-over-a-canvas shape. Owns the cross-cutting effects
 * that used to live in /v2's single page.tsx (⌘K shortcut, Google OAuth
 * popup postMessage handling) since those apply regardless of which route
 * is active.
 *
 * @module app/v3/_components/V3Shell
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useV3 } from '../_lib/SessionContext';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { SettingsPanel } from './SettingsPanel';
import { NewProjectModal } from './NewProjectModal';
import { ToastStack } from './Toasts';
import { CommandPalette, type Command } from './CommandPalette';
import { AgentIcon, BarIcon, BoltIcon, GridIcon, LayersIcon, LogoutIcon, PlugIcon, PlusIcon, SyncIcon, UsersIcon } from './icons';
import { listGoogleConnections } from '@/lib/terminal-api';
import { API_URL } from '@/lib/api';

export function V3Shell({ children }: { children: ReactNode }) {
  const {
    session: c,
    notify,
    toasts,
    dismissToast,
    integrations,
    panel,
    setPanel,
    newProject,
    setNewProject,
    palette,
    setPalette,
  } = useV3();
  const router = useRouter();
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
        setPalette(!palette);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette]);

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

  if (c.fatal) {
    return (
      <div className="v3 grid min-h-screen place-items-center p-6 text-center font-sans">
        <div>
          <p className="font-display text-display text-danger">{c.fatal}</p>
          <p className="mt-2 text-body text-faint">Is the backend running on {API_URL}?</p>
        </div>
      </div>
    );
  }

  const commands: Command[] = [
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
      id: 'w:overview',
      label: 'Overview',
      group: 'Workspace' as const,
      keywords: 'flywheel home canvas',
      icon: <GridIcon className="h-4 w-4" />,
      run: () => router.push('/v3'),
    },
    {
      id: 'w:presence',
      label: 'Digital presence — accounts, listings, footprint',
      group: 'Workspace' as const,
      keywords: 'presence social instagram linkedin facebook accounts discovery footprint',
      icon: <LayersIcon className="h-4 w-4" />,
      run: () => router.push('/v3/presence'),
    },
    {
      id: 'w:technical',
      label: 'Technical audit',
      group: 'Workspace' as const,
      keywords: 'crawl access performance stack tech',
      icon: <BarIcon className="h-4 w-4" />,
      run: () => router.push('/v3/audits/technical'),
    },
    {
      id: 'w:seo',
      label: 'SEO audit',
      group: 'Workspace' as const,
      keywords: 'search console queries pages',
      icon: <BarIcon className="h-4 w-4" />,
      run: () => router.push('/v3/audits/seo'),
    },
    {
      id: 'w:aeo',
      label: 'AEO audit — ChatGPT, Perplexity, Gemini',
      group: 'Workspace' as const,
      keywords: 'aeo answer engine visibility chatgpt perplexity gemini ai search',
      icon: <SyncIcon className="h-4 w-4" />,
      run: () => router.push('/v3/audits/aeo'),
    },
    {
      id: 'w:rivals',
      label: 'Rivals — gap vs your competitors',
      group: 'Workspace' as const,
      keywords: 'competitors rivals gap comparison tech schema presence',
      icon: <UsersIcon className="h-4 w-4" />,
      run: () => router.push('/v3/rivals'),
    },
    {
      id: 'w:keywords',
      label: 'Keywords — demand research',
      group: 'Workspace' as const,
      keywords: 'keyword research volume competition cpc',
      icon: <SyncIcon className="h-4 w-4" />,
      run: () => router.push('/v3/keywords'),
    },
    {
      id: 'w:agents',
      label: 'Agents — run and read',
      group: 'Workspace' as const,
      keywords: 'agent reports swarm authority findings personas council journeys',
      icon: <AgentIcon agentKey="seo" size={16} />,
      run: () => router.push('/v3/agents'),
    },
    {
      id: 'w:reports',
      label: 'Reports — what the client gets',
      group: 'Workspace' as const,
      keywords: 'deliverables scorecard branded report',
      icon: <BarIcon className="h-4 w-4" />,
      run: () => router.push('/v3/reports'),
    },
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
    <div className="v3 flex h-screen overflow-hidden font-sans">
      <Sidebar
        user={c.user}
        projects={c.projects}
        activeId={c.activeId}
        onSelect={c.selectProject}
        onNewProject={() => setNewProject(true)}
        onLogout={c.logout}
        onOpenConnections={() => setPanel('connections')}
        onOpenUsers={() => setPanel('users')}
        connectedCount={c.integrations ? integrations.filter((i) => i.connected).length + (googleConnected ?? 0) : null}
        disabled={!c.activeId}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <Topbar onNewProject={() => setNewProject(true)} onOpenPalette={() => setPalette(true)} />
        {children}
      </div>

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

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
