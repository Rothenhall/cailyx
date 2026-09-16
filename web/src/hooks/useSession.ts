'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import type { SafeUser } from '@/services/types';

/**
 * Client-side session state.
 *
 * This is a *convenience* view of the session for rendering the account menu
 * and filtering navigation by role. It is never the authorization boundary:
 * every scoped read is enforced by NestJS from the JWT, and the tokens
 * themselves live in HttpOnly cookies this code cannot see.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export interface SessionState {
  status: SessionStatus;
  user: SafeUser | null;
  /** True when the operator must replace a temporary password before continuing. */
  mustChangePassword: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useSession(): SessionState {
  const router = useRouter();
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [user, setUser] = useState<SafeUser | null>(null);

  const load = useCallback(async () => {
    try {
      // /auth/me is operator-only; a client-type user is served by /portal/me.
      // Trying the operator route first and falling back keeps one hook for
      // both surfaces without asking the caller which it is.
      let profile: SafeUser;
      try {
        profile = await api.get<SafeUser>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && (error.kind === 'forbidden' || error.kind === 'not-found')) {
          profile = await api.get<SafeUser>('/portal/me');
        } else {
          throw error;
        }
      }
      setUser({ ...profile, type: profile.type ?? 'operator' });
      setStatus('authenticated');
    } catch (error) {
      // A 401 here is the normal "not signed in" case, not a failure to report.
      if (error instanceof ApiError && error.kind === 'unauthenticated') {
        setUser(null);
        setStatus('anonymous');
        return;
      }
      if (error instanceof ApiError && error.kind === 'network') {
        // Keep the last known identity rather than flickering to signed-out
        // on a transient blip.
        setStatus((current) => (current === 'authenticated' ? current : 'anonymous'));
        return;
      }
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/session/logout', { method: 'POST' });
    } finally {
      setUser(null);
      setStatus('anonymous');
      router.push('/sign-in');
      router.refresh();
    }
  }, [router]);

  return {
    status,
    user,
    mustChangePassword: user?.mustChangePassword === true,
    refresh: load,
    signOut,
  };
}
