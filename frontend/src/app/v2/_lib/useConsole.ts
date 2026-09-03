'use client';

/**
 * useConsole — the /v2 data spine. Owns everything the page needs from the
 * backend: the auth guard, the bootstrap fan-out (me · projects · integrations),
 * the per-project fan-out (project · agents · suggestion wheel), the agents
 * poll, and the mutations the surfaces fire (patch project, create project,
 * refresh, logout).
 *
 * Every payload is painted from the localStorage cache first and refreshed
 * underneath, so switching projects never blanks a card. Responses that land
 * after the operator has already switched away are dropped.
 *
 * @module app/v2/_lib/useConsole
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, cacheGet, cacheSet, getToken, setSession } from '@/lib/api';
import {
  createProject,
  getAgents,
  getIntegrations,
  getMe,
  getProject,
  getSuggestions,
  listProjects,
  patchProject,
} from '@/lib/terminal-api';
import type { User } from '@/types/api';
import type { AgentsResponse, IntegrationsResponse, ProjectDetail } from '@/types/terminal';
import type { SuggestionWheel } from '@/components/terminal/Flywheel';

/** shared with the v1 console so the active project carries between surfaces */
const LAST_KEY = 'cailyx.lastProject';
const POLL_MS = 25_000;

export interface ConsoleApi {
  /* identity */
  user: User | null;
  /* projects */
  projects: ProjectDetail[];
  activeId: string | null;
  project: ProjectDetail | null;
  selectProject: (id: string) => void;
  /** true while a project with nothing cached is still in flight */
  projectPending: boolean;
  /* agents */
  agents: AgentsResponse | null;
  agentsLoading: boolean;
  refreshAgents: () => void;
  /* integrations */
  integrations: IntegrationsResponse | null;
  refreshIntegrations: () => Promise<void>;
  /* flywheel */
  wheel: SuggestionWheel | null;
  wheelLoading: boolean;
  /* mutations */
  saveProject: (
    patch: Partial<Pick<ProjectDetail, 'name' | 'category' | 'clientName' | 'notes'>>,
  ) => Promise<void>;
  addProject: (input: { name: string; domain: string; category?: string }) => Promise<ProjectDetail>;
  logout: () => void;
  /* lifecycle */
  fatal: string | null;
  /** the first fan-out has not settled yet — surfaces should show skeletons */
  booting: boolean;
  /** no projects exist yet — the page should prompt for the first one */
  needsFirstProject: boolean;
}

export function useConsole(): ConsoleApi {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<ProjectDetail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null);
  const [wheel, setWheel] = useState<SuggestionWheel | null>(null);
  const [wheelLoading, setWheelLoading] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [needsFirstProject, setNeedsFirstProject] = useState(false);

  /** the id the UI is actually showing — guards late responses */
  const liveId = useRef<string | null>(null);
  liveId.current = activeId;

  const bail = useCallback(() => {
    setSession(null);
    router.replace('/login');
  }, [router]);

  /* ── bootstrap: paint from cache, then refresh ─────────────────────── */
  useEffect(() => {
    if (typeof window !== 'undefined' && getToken() === null) {
      router.replace('/login');
      return;
    }

    const cachedUser = cacheGet<User>('me');
    const cachedProjects = cacheGet<ProjectDetail[]>('projects');
    const cachedInteg = cacheGet<IntegrationsResponse>('integrations');
    if (cachedUser) setUser(cachedUser);
    if (cachedProjects) setProjects(cachedProjects);
    if (cachedInteg) setIntegrations(cachedInteg);

    const last = (() => {
      try {
        return window.localStorage.getItem(LAST_KEY);
      } catch {
        return null;
      }
    })();
    if (cachedProjects?.length) {
      setActiveId(cachedProjects.find((p) => p.id === last)?.id ?? cachedProjects[0].id);
    }

    void (async () => {
      try {
        const [me, ps, ig] = await Promise.all([getMe(), listProjects(), getIntegrations()]);
        setUser(me);
        setProjects(ps);
        setIntegrations(ig);
        cacheSet('me', me);
        cacheSet('projects', ps);
        cacheSet('integrations', ig);
        setActiveId((cur) => cur ?? ps.find((p) => p.id === last)?.id ?? ps[0]?.id ?? null);
        setNeedsFirstProject(ps.length === 0);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          bail();
          return;
        }
        // the cache may already have painted a usable console — only hard-fail
        // when there is genuinely nothing on screen
        if (!cachedProjects) setFatal(err instanceof Error ? err.message : 'Failed to reach the backend');
      } finally {
        setBooting(false);
      }
    })();
  }, [router, bail]);

  /* ── per-project fan-out ───────────────────────────────────────────── */
  const loadProject = useCallback(
    async (id: string) => {
      setAgentsLoading(true);
      try {
        const [p, a] = await Promise.all([getProject(id), getAgents(id)]);
        cacheSet(`project.${id}`, p);
        cacheSet(`agents.${id}`, a);
        if (liveId.current === id) {
          setProject(p);
          setAgents(a);
        }
        setProjects((prev) => prev.map((x) => (x.id === id ? { ...x, ...p } : x)));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) bail();
        // otherwise keep whatever the cache painted
      } finally {
        setAgentsLoading(false);
        if (liveId.current === id) setProjectPending(false);
      }
    },
    [bail],
  );

  useEffect(() => {
    if (!activeId) return;
    try {
      window.localStorage.setItem(LAST_KEY, activeId);
    } catch {
      /* ignore */
    }
    const cachedP = cacheGet<ProjectDetail>(`project.${activeId}`);
    const cachedA = cacheGet<AgentsResponse>(`agents.${activeId}`);
    setProject(cachedP);
    setAgents(cachedA);
    setProjectPending(!cachedP);
    void loadProject(activeId);
  }, [activeId, loadProject]);

  /* agents poll — keeps the roster warm without a manual refresh */
  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => {
      getAgents(activeId)
        .then((a) => {
          if (liveId.current !== activeId) return;
          setAgents(a);
          cacheSet(`agents.${activeId}`, a);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [activeId]);

  /* suggestion wheel — one fetch per project, cache-seeded */
  useEffect(() => {
    if (!activeId) return;
    const forId = activeId;
    setWheel(cacheGet<SuggestionWheel>(`wheel.${forId}`));
    setWheelLoading(true);
    getSuggestions(forId)
      .then((w) => {
        cacheSet(`wheel.${forId}`, w);
        if (liveId.current === forId) setWheel(w);
      })
      .catch(() => {})
      .finally(() => {
        if (liveId.current === forId) setWheelLoading(false);
      });
  }, [activeId]);

  /* ── actions ───────────────────────────────────────────────────────── */
  const refreshAgents = useCallback(() => {
    const id = liveId.current;
    if (!id) return;
    setAgentsLoading(true);
    getAgents(id)
      .then((a) => {
        if (liveId.current !== id) return;
        setAgents(a);
        cacheSet(`agents.${id}`, a);
      })
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, []);

  const refreshIntegrations = useCallback(async () => {
    try {
      const ig = await getIntegrations();
      setIntegrations(ig);
      cacheSet('integrations', ig);
    } catch {
      /* non-fatal — keep the last-known list */
    }
  }, []);

  const saveProject = useCallback(
    async (patch: Partial<Pick<ProjectDetail, 'name' | 'category' | 'clientName' | 'notes'>>) => {
      const id = liveId.current;
      if (!id) throw new Error('no active project');
      const p = await patchProject(id, patch);
      cacheSet(`project.${id}`, p);
      if (liveId.current === id) setProject(p);
      setProjects((prev) => prev.map((x) => (x.id === id ? { ...x, ...p } : x)));
    },
    [],
  );

  const addProject = useCallback(async (input: { name: string; domain: string; category?: string }) => {
    const p = await createProject(input);
    cacheSet(`project.${p.id}`, p);
    setProjects((prev) => [p, ...prev]);
    setProject(p);
    setActiveId(p.id);
    setNeedsFirstProject(false);
    return p;
  }, []);

  const logout = useCallback(() => bail(), [bail]);

  return {
    user,
    projects,
    activeId,
    project,
    selectProject: setActiveId,
    projectPending,
    agents,
    agentsLoading,
    refreshAgents,
    integrations,
    refreshIntegrations,
    wheel,
    wheelLoading,
    saveProject,
    addProject,
    logout,
    fatal,
    booting,
    needsFirstProject,
  };
}
