'use client';

/**
 * Route guard: redirects to /login if no session exists, or to the other
 * surface if the logged-in user's type doesn't match this route (a client
 * hitting /admin, or an operator hitting /portal). This is a UX nicety —
 * the real boundary is the backend's RolesGuard, which 403s the underlying
 * API calls regardless of what this hook does.
 *
 * @module lib/useRequireAuth
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, getUser } from '@/lib/api';
import type { AuthUser, UserType } from '@/types/api';

export function useRequireAuth(requiredType: UserType): AuthUser | null {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const token = getToken();
    const u = getUser();
    if (!token || !u) {
      router.replace('/login');
      return;
    }
    if (u.type !== requiredType) {
      router.replace(u.type === 'client' ? '/portal' : '/admin');
      return;
    }
    setUser(u);
  }, [router, requiredType]);

  return user;
}
