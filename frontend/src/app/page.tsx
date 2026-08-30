'use client';

/**
 * Cailyx — the operator console. Top bar + a movable / resizable / hideable set
 * of panes (Analytics · Context · Agents Feed · Chat) for the active project.
 * Layout is persisted per browser.
 *
 * @module app/page
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, setToken, ApiError } from '@/lib/api';
import {
  createProject,
  getAgents,
  getIntegrations,
  getProject,
  getMe,
  listProjects,
} from '@/lib/terminal-api';
import type { User } from '@/types/api';
import type { AgentsResponse, IntegrationsResponse, ProjectDetail } from '@/types/terminal';
import { TopBar } from '@/components/terminal/TopBar';
import { Pane } from '@/components/terminal/Pane';
import { AnalyticsPane, analyticsMeta } from '@/components/terminal/AnalyticsPane';
import { ContextPane, contextMeta } from '@/components/terminal/ContextPane';
import { AgentsFeed, agentsMeta } from '@/components/terminal/AgentsFeed';
import { ChatPane, chatMeta } from '@/components/terminal/ChatPane';
import { ConnectionsModal } from '@/components/terminal/ConnectionsModal';
import { UsersModal } from '@/components/terminal/UsersModal';

type PaneKey = 'analytics' | 'context' | 'agents' | 'chat';
const PANE_META: Record<PaneKey, { title: string; icon: string }> = {
  analytics: { title: analyticsMeta.title, icon: analyticsMeta.icon },
  context: { title: contextMeta.title, icon: contextMeta.icon },
  agents: { title: agentsMeta.title, icon: agentsMeta.icon },
  chat: { title: chatMeta.title, icon: chatMeta.icon },
};

interface Layout {
  order: PaneKey[];
  widths: Record<PaneKey, number>;
  hidden: PaneKey[];
}
const DEFAULT_LAYOUT: Layout = {
  order: ['analytics', 'context', 'agents', 'chat'],
  widths: { analytics: 300, context: 320, agents: 300, chat: 380 },
  hidden: [],
};
const LAYOUT_KEY = 'cailyx.layout';
const LAST_KEY = 'cailyx.lastProject';

function loadLayout(): Layout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const p = JSON.parse(raw) as Partial<Layout>;
    const keys: PaneKey[] = ['analytics', 'context', 'agents', 'chat'];
    const order = (p.order ?? []).filter((k): k is PaneKey => keys.includes(k as PaneKey));
    for (const k of keys) if (!order.includes(k)) order.push(k);
    return {
      order,
      widths: { ...DEFAULT_LAYOUT.widths, ...(p.widths ?? {}) },
      hidden: (p.hidden ?? []).filter((k): k is PaneKey => keys.includes(k as PaneKey)),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export default function TerminalPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<ProjectDetail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [integ, setInteg] = useState<IntegrationsResponse | null>(null);
  const [modal, setModal] = useState<null | 'connections' | 'users' | 'new'>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setLayout(loadLayout());
    setHydrated(true);
  }, []);

  const persistLayout = useCallback((next: Layout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  /* auth gate + bootstrap */
  useEffect(() => {
    if (typeof window !== 'undefined' && getToken() === null) {
      router.replace('/login');
      return;
    }
    void (async () => {
      try {
        const [me, ps, ig] = await Promise.all([getMe(), listProjects(), getIntegrations()]);
        setUser(me);
        setProjects(ps);
        setInteg(ig);
        const last = (() => {
          try {
            return window.localStorage.getItem(LAST_KEY);
          } catch {
            return null;
          }
        })();
        setActiveId(ps.find((p) => p.id === last)?.id ?? ps[0]?.id ?? null);
        if (ps.length === 0) setModal('new');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setToken(null);
          router.replace('/login');
          return;
        }
        setFatal(err instanceof Error ? err.message : 'Failed to reach the backend');
      }
    })();
  }, [router]);

  const loadProject = useCallback(
    async (id: string) => {
      setAgentsLoading(true);
      try {
        const [p, a] = await Promise.all([getProject(id), getAgents(id)]);
        setProject(p);
        setAgents(a);
        setProjects((prev) => prev.map((x) => (x.id === id ? { ...x, ...p } : x)));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setToken(null);
          router.replace('/login');
        }
      } finally {
        setAgentsLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    if (!activeId) return;
    try {
      window.localStorage.setItem(LAST_KEY, activeId);
    } catch {
      /* ignore */
    }
    setProject(null);
    setAgents(null);
    void loadProject(activeId);
  }, [activeId, loadProject]);

  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => {
      getAgents(activeId).then(setAgents).catch(() => {});
    }, 25000);
    return () => clearInterval(t);
  }, [activeId]);

  const refreshAgents = () => {
    if (!activeId) return;
    setAgentsLoading(true);
    getAgents(activeId).then(setAgents).finally(() => setAgentsLoading(false));
  };

  const logout = () => {
    setToken(null);
    router.replace('/login');
  };

  /* ── layout ops ─────────────────────────────────────────── */
  const visibleOrder = useMemo(
    () => layout.order.filter((k) => !layout.hidden.includes(k)),
    [layout.order, layout.hidden],
  );

  const movePane = (key: PaneKey, dir: -1 | 1) => {
    const vis = visibleOrder;
    const vi = vis.indexOf(key);
    const target = vis[vi + dir];
    if (!target) return;
    const order = [...layout.order];
    const a = order.indexOf(key);
    const b = order.indexOf(target);
    [order[a], order[b]] = [order[b], order[a]];
    persistLayout({ ...layout, order });
  };

  const setWidth = (key: PaneKey, w: number) =>
    persistLayout({ ...layout, widths: { ...layout.widths, [key]: Math.round(w) } });

  const togglePane = (key: string) => {
    const k = key as PaneKey;
    const hidden = layout.hidden.includes(k)
      ? layout.hidden.filter((x) => x !== k)
      : [...layout.hidden, k];
    persistLayout({ ...layout, hidden });
  };

  const resetLayout = () => persistLayout(DEFAULT_LAYOUT);

  if (fatal) {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <div>
          <p className="text-red">{fatal}</p>
          <p className="mt-2 text-[12px] text-faint">Is the backend running on {process.env.NEXT_PUBLIC_API_URL}?</p>
        </div>
      </div>
    );
  }

  const paneToggles = layout.order.map((k) => ({
    key: k,
    title: PANE_META[k].title,
    visible: !layout.hidden.includes(k),
  }));

  const renderPane = (key: PaneKey, i: number) => {
    const width = layout.widths[key];
    const canLeft = i > 0;
    const canRight = i < visibleOrder.length - 1;
    const move = (dir: -1 | 1) => () => movePane(key, dir);

    if (key === 'chat') {
      return (
        <ChatPane
          key="chat"
          project={project}
          agents={agents}
          integrations={integ?.integrations ?? []}
          onOpenConnections={() => setModal('connections')}
          width={width}
          onResize={(w) => setWidth('chat', w)}
          onMoveLeft={move(-1)}
          onMoveRight={move(1)}
          onHide={() => togglePane('chat')}
          canMoveLeft={canLeft}
          canMoveRight={canRight}
        />
      );
    }

    const meta = PANE_META[key];
    const body =
      key === 'analytics' ? (
        <AnalyticsPane
          projectId={activeId}
          domain={project?.domain ?? null}
          integrations={integ?.integrations ?? []}
        />
      ) : key === 'context' ? (
        <ContextPane
          project={project}
          agents={agents}
          onProjectChanged={(p) => {
            setProject(p);
            setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...p } : x)));
          }}
        />
      ) : (
        <AgentsFeed data={agents} loading={agentsLoading} />
      );

    return (
      <Pane
        key={key}
        title={meta.title}
        icon={<span className={key === 'agents' ? 'pulse-dot text-accent' : undefined}>{meta.icon}</span>}
        width={width}
        onResize={(w) => setWidth(key, w)}
        onMoveLeft={move(-1)}
        onMoveRight={move(1)}
        onHide={() => togglePane(key)}
        canMoveLeft={canLeft}
        canMoveRight={canRight}
        headerRight={
          key === 'agents' ? (
            <button onClick={refreshAgents} title="Refresh" className="rounded p-1 text-faint hover:bg-bg-inset hover:text-dim">
              ↻
            </button>
          ) : undefined
        }
      >
        {body}
      </Pane>
    );
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar
        user={user}
        projects={projects}
        activeId={activeId}
        onSelect={setActiveId}
        onNewProject={() => setModal('new')}
        onLogout={logout}
        onOpenConnections={() => setModal('connections')}
        onOpenUsers={() => setModal('users')}
        connectedCount={integ?.summary.connected ?? null}
        panes={paneToggles}
        onTogglePane={togglePane}
        onResetLayout={resetLayout}
      />

      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {hydrated && visibleOrder.map((k, i) => renderPane(k, i))}
        {hydrated && visibleOrder.length === 0 && (
          <p className="p-6 text-faint">all panes hidden — use the layout menu to bring one back.</p>
        )}
      </div>

      {modal === 'connections' && integ && (
        <ConnectionsModal integrations={integ.integrations} summary={integ.summary} onClose={() => setModal(null)} />
      )}
      {modal === 'users' && <UsersModal currentUserId={user?.id ?? null} onClose={() => setModal(null)} />}
      {modal === 'new' && (
        <NewProjectModal
          onClose={() => setModal(null)}
          onCreated={(p) => {
            setProjects((prev) => [p, ...prev]);
            setActiveId(p.id);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

/* ── new project modal ──────────────────────────────────────── */
function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: ProjectDetail) => void;
}) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const p = await createProject({ name, domain, category: category || undefined });
      onCreated(p);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-lg border border-border bg-bg-raised p-5">
        <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-dim">New project</h2>
        <div className="space-y-3">
          <Field label="name" value={name} onChange={setName} required minLength={2} />
          <Field label="domain" value={domain} onChange={setDomain} placeholder="acme.com" required />
          <Field label="category (optional)" value={category} onChange={setCategory} placeholder="AI visibility diagnostics" />
          {err && <p className="text-[11px] text-red">{err}</p>}
          <div className="flex gap-2">
            <button disabled={busy} className="flex-1 rounded border border-accent-dim bg-accent-dim/20 px-3 py-2 text-[12px] text-accent disabled:opacity-50">
              {busy ? '…' : 'create'}
            </button>
            <button type="button" onClick={onClose} className="rounded border border-border px-3 py-2 text-[12px] text-faint">
              cancel
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        className="w-full rounded-md border border-border bg-bg-inset px-3 py-2 text-[13px] outline-none focus:border-border-strong"
      />
    </label>
  );
}
