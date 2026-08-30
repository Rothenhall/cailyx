'use client';

/**
 * Cailyx — the operator console as an infinite canvas. Top bar + a pannable /
 * zoomable stage of draggable, resizable cards (Analytics · Context · Agents ·
 * Chat · Gates). Card boxes + viewport persist per browser.
 *
 * @module app/page
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Canvas, type Box, type CanvasHandle, type Viewport } from '@/components/canvas/Canvas';
import { CanvasCard } from '@/components/canvas/CanvasCard';
import { AnalyticsPane, analyticsMeta } from '@/components/terminal/AnalyticsPane';
import { ContextPane, contextMeta } from '@/components/terminal/ContextPane';
import { AgentsFeed, agentsMeta } from '@/components/terminal/AgentsFeed';
import { ChatPane, chatMeta } from '@/components/terminal/ChatPane';
import { GatesCard, gatesMeta } from '@/components/terminal/GatesCard';
import { ConnectionsModal } from '@/components/terminal/ConnectionsModal';
import { UsersModal } from '@/components/terminal/UsersModal';

type CardKey = 'analytics' | 'context' | 'agents' | 'chat' | 'gates';
const CARD_ORDER: CardKey[] = ['analytics', 'context', 'agents', 'chat', 'gates'];
const CARD_META: Record<CardKey, { title: string; icon: string }> = {
  analytics: { title: analyticsMeta.title, icon: analyticsMeta.icon },
  context: { title: contextMeta.title, icon: contextMeta.icon },
  agents: { title: agentsMeta.title, icon: agentsMeta.icon },
  chat: { title: chatMeta.title, icon: chatMeta.icon },
  gates: { title: gatesMeta.title, icon: gatesMeta.icon },
};

interface CanvasLayout {
  viewport: Viewport;
  nodes: Record<CardKey, Box>;
  hidden: CardKey[];
}
const DEFAULT_LAYOUT: CanvasLayout = {
  viewport: { x: 24, y: 20, z: 1 },
  nodes: {
    // a compact 3 + 2 cluster so "fit" frames it nicely on any screen
    analytics: { x: 0, y: 0, w: 340, h: 600 },
    context: { x: 360, y: 0, w: 360, h: 600 },
    agents: { x: 740, y: 0, w: 340, h: 600 },
    chat: { x: 0, y: 632, w: 420, h: 520 },
    gates: { x: 440, y: 632, w: 380, h: 520 },
  },
  hidden: [],
};
const KEY = 'cailyx.canvas';
const LAST_KEY = 'cailyx.lastProject';

function loadLayout(): CanvasLayout {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const p = JSON.parse(raw) as Partial<CanvasLayout>;
    return {
      viewport: { ...DEFAULT_LAYOUT.viewport, ...(p.viewport ?? {}) },
      nodes: { ...DEFAULT_LAYOUT.nodes, ...(p.nodes ?? {}) },
      hidden: (p.hidden ?? []).filter((k): k is CardKey => CARD_ORDER.includes(k as CardKey)),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export default function CanvasConsole() {
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
  const [layout, setLayout] = useState<CanvasLayout>(DEFAULT_LAYOUT);
  const [hydrated, setHydrated] = useState(false);
  const [focused, setFocused] = useState<CardKey | null>(null);
  const canvasApi = useRef<CanvasHandle | null>(null);

  useEffect(() => {
    setLayout(loadLayout());
    setHydrated(true);
  }, []);

  const persist = useCallback((next: CanvasLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  /* auth + bootstrap */
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

  /* ── canvas ops ─────────────────────────────────────────── */
  const setNode = (k: CardKey, b: Box) => persist({ ...layout, nodes: { ...layout.nodes, [k]: b } });
  const setViewport = (v: Viewport) => persist({ ...layout, viewport: v });
  const toggleCard = (key: string) => {
    const k = key as CardKey;
    persist({
      ...layout,
      hidden: layout.hidden.includes(k) ? layout.hidden.filter((x) => x !== k) : [...layout.hidden, k],
    });
  };
  const visible = useMemo(() => CARD_ORDER.filter((k) => !layout.hidden.includes(k)), [layout.hidden]);
  const resetView = () => canvasApi.current?.reset();
  const fitView = () => canvasApi.current?.fit(visible.map((k) => layout.nodes[k]));

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

  const cardToggles = CARD_ORDER.map((k) => ({
    key: k,
    title: CARD_META[k].title,
    visible: !layout.hidden.includes(k),
  }));

  const renderBody = (k: CardKey) => {
    switch (k) {
      case 'analytics':
        return <AnalyticsPane projectId={activeId} domain={project?.domain ?? null} integrations={integ?.integrations ?? []} />;
      case 'context':
        return (
          <ContextPane
            project={project}
            agents={agents}
            onProjectChanged={(p) => {
              setProject(p);
              setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...p } : x)));
            }}
          />
        );
      case 'agents':
        return <AgentsFeed data={agents} loading={agentsLoading} />;
      case 'chat':
        return (
          <ChatPane
            project={project}
            agents={agents}
            integrations={integ?.integrations ?? []}
            onOpenConnections={() => setModal('connections')}
          />
        );
      case 'gates':
        return <GatesCard integrations={integ?.integrations ?? []} />;
    }
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
        cards={cardToggles}
        onToggleCard={toggleCard}
        onResetView={resetView}
        onFitView={fitView}
        zoom={layout.viewport.z}
      />

      <div className="relative min-h-0 flex-1">
        {hydrated && (
          <Canvas
            viewport={layout.viewport}
            onViewport={setViewport}
            onBackgroundClick={() => setFocused(null)}
            apiRef={canvasApi}
          >
            {visible.map((k) => (
              <div key={k} style={{ position: 'absolute', zIndex: focused === k ? 20 : 1 }}>
                <CanvasCard
                  box={layout.nodes[k]}
                  zoom={layout.viewport.z}
                  title={CARD_META[k].title}
                  icon={<span className={k === 'agents' ? 'pulse-dot text-accent' : undefined}>{CARD_META[k].icon}</span>}
                  variant={k === 'chat' ? 'dark' : 'default'}
                  onChange={(b) => setNode(k, b)}
                  onHide={() => toggleCard(k)}
                  onFocus={() => setFocused(k)}
                  headerRight={
                    k === 'agents' ? (
                      <button onClick={refreshAgents} title="Refresh" className="rounded p-1 text-faint hover:bg-bg-inset hover:text-dim">
                        ↻
                      </button>
                    ) : undefined
                  }
                >
                  {renderBody(k)}
                </CanvasCard>
              </div>
            ))}
          </Canvas>
        )}

        {/* zoom controls */}
        <div className="absolute bottom-4 left-4 z-30 flex items-center gap-1 rounded-md border border-border bg-bg-raised/90 px-1 py-0.5 text-xs backdrop-blur">
          <button onClick={() => canvasApi.current?.zoomBy(1 / 1.2)} className="rounded px-2 py-1 text-faint hover:bg-bg-inset hover:text-dim">−</button>
          <span className="w-10 text-center text-faint">{Math.round(layout.viewport.z * 100)}%</span>
          <button onClick={() => canvasApi.current?.zoomBy(1.2)} className="rounded px-2 py-1 text-faint hover:bg-bg-inset hover:text-dim">+</button>
          <span className="mx-1 h-4 w-px bg-border" />
          <button onClick={fitView} className="rounded px-2 py-1 text-faint hover:bg-bg-inset hover:text-dim">fit</button>
        </div>
        <p className="absolute bottom-4 right-4 z-30 rounded bg-bg-raised/80 px-2 py-1 text-[10px] text-faint backdrop-blur">
          drag empty space to pan · scroll to zoom · drag a card header to move it
        </p>
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
