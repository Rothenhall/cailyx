'use client';

/**
 * useSession — the /v3 durable core: auth guard, identity, project list,
 * active project, agents roster, integrations, and the mutations every route
 * needs (save/add project, logout). Split out of /v2's useConsole, which also
 * carried the Overview-only Flywheel wheel + query-sets fetches — those now
 * live in useOverview.ts, fetched only on the route that renders them.
 *
 * Same idioms as useConsole: paint from the localStorage cache first, refresh
 * underneath, and drop any response that lands after the operator has
 * switched away (`liveId` ref guard).
 *
 * @module app/v3/_lib/useSession
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, cacheGet, cacheSet, getToken, setSession as setStoredSession } from '@/lib/api';
import { createProject, getAgents, getIntegrations, getMe, getProject, listProjects, patchProject } from '@/lib/terminal-api';
import type { User } from '@/types/api';
import type { AgentsResponse, IntegrationsResponse, ProjectDetail } from '@/types/terminal';

/** shared with v1/v2 so the active project carries between every surface */
const LAST_KEY = 'cailyx.lastProject';
const POLL_MS = 25_000;

export interface SessionApi {
  user: User | null;
  projects: ProjectDetail[];
  activeId: string | null;
  project: ProjectDetail | null;
  selectProject: (id: string) => void;
  projectPending: boolean;
  agents: AgentsResponse | null;
  agentsLoading: boolean;
  refreshAgents: () => void;
  refreshAgentsAnd: (then: (next: AgentsResponse) => void) => Promise<void>;
  integrations: IntegrationsResponse | null;
  refreshIntegrations: () => Promise<void>;
  saveProject: (patch: Partial<Pick<ProjectDetail, 'name' | 'category' | 'clientName' | 'notes'>>) => Promise<void>;
  addProject: (input: { name: string; domain: string; category?: string }) => Promise<ProjectDetail>;
  logout: () => void;
  fatal: string | null;
  booting: boolean;
  needsFirstProject: boolean;
}

export function useSession(): SessionApi {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<ProjectDetail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [needsFirstProject, setNeedsFirstProject] = useState(false);

  const liveId = useRef<string | null>(null);
  liveId.current = activeId;

  const bail = useCallback(() => {
    setStoredSession(null);
    router.replace('/login');
  }, [router]);

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
        if (!cachedProjects) setFatal(err instanceof Error ? err.message : 'Failed to reach the backend');
      } finally {
        setBooting(false);
      }
    })();
  }, [router, bail]);

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

  const refreshAgentsAnd = useCallback(async (then: (next: AgentsResponse) => void) => {
    const id = liveId.current;
    if (!id) return;
    setAgentsLoading(true);
    try {
      const a = await getAgents(id);
      cacheSet(`agents.${id}`, a);
      if (liveId.current === id) {
        setAgents(a);
        then(a);
      }
    } catch {
      /* the run itself already succeeded — a failed refresh is not fatal */
    } finally {
      setAgentsLoading(false);
    }
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
    refreshAgentsAnd,
    integrations,
    refreshIntegrations,
    saveProject,
    addProject,
    logout,
    fatal,
    booting,
    needsFirstProject,
  };
}
