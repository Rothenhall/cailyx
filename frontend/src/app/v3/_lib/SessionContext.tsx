'use client';

/**
 * SessionContext — the cross-cutting state every /v3 route needs: the
 * session (identity/projects/agents/integrations), toast notifications, and
 * the shared overlay controls (settings panel, new-project modal, command
 * palette). Owned once in layout.tsx, consumed by every nested route so each
 * page.tsx only deals with its own workspace, not chrome plumbing.
 *
 * @module app/v3/_lib/SessionContext
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useSession, type SessionApi } from './useSession';
import { useToasts, type Toast } from '../_components/Toasts';
import { HIDDEN_INTEGRATIONS } from '../_components/SettingsPanel';
import type { IntegrationsResponse } from '@/types/terminal';

interface V3Context {
  session: SessionApi;
  notify: (msg: string, tone?: 'ok' | 'warn') => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  /** integrations with the always-hidden Google rows filtered out */
  integrations: IntegrationsResponse['integrations'];
  panel: 'connections' | 'users' | null;
  setPanel: (p: 'connections' | 'users' | null) => void;
  newProject: boolean;
  setNewProject: (v: boolean) => void;
  palette: boolean;
  setPalette: (v: boolean) => void;
}

const Ctx = createContext<V3Context | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const { toasts, notify, dismiss } = useToasts();
  const [panel, setPanel] = useState<'connections' | 'users' | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [palette, setPalette] = useState(false);

  const integrations = useMemo(
    () => (session.integrations?.integrations ?? []).filter((i) => !HIDDEN_INTEGRATIONS.has(i.key)),
    [session.integrations],
  );

  const value: V3Context = {
    session,
    notify,
    toasts,
    dismissToast: dismiss,
    integrations,
    panel,
    setPanel,
    newProject,
    setNewProject,
    palette,
    setPalette,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useV3(): V3Context {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useV3 must be used within SessionProvider (v3/layout.tsx)');
  return ctx;
}
