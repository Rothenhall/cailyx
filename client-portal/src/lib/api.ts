/**
 * Thin typed fetch client for the Cailyx backend API — ported from
 * frontend/src/lib/api.ts with two deliberate differences:
 *   - separate localStorage key prefix (`cailyxPortal.*` not `cailyx.*`) so
 *     this app's session never collides with frontend/'s if both are open
 *     in the same browser profile
 *   - also persists the logged-in `user` object (type/clientId included),
 *     so the route guard and "who am I" UI never need an extra round-trip
 *
 * - attaches the stored bearer token
 * - on a 401, transparently rotates the refresh token once and retries
 * - normalizes NestJS error payloads into `ApiError`
 *
 * @module lib/api
 */

import type { AuthUser } from '@/types/api';

export const API_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:3002';

const TOKEN_KEY = 'cailyxPortal.token';
const REFRESH_KEY = 'cailyxPortal.refresh';
const USER_KEY = 'cailyxPortal.user';

/** NestJS error payload shape ({ message, error, statusCode }). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/* ── token + user store ──────────────────────────────────────── */

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode) — auth simply won't persist */
  }
}

function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function getUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function setUser(user: AuthUser | null): void {
  try {
    if (user === null) window.localStorage.removeItem(USER_KEY);
    else window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

/** Store an access + refresh pair (call after login), optionally the user too. */
export function setSession(s: { accessToken: string; refreshToken?: string | null; user?: AuthUser } | null): void {
  if (s === null) {
    setToken(null);
    setUser(null);
    try {
      window.localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  setToken(s.accessToken);
  if (s.user) setUser(s.user);
  try {
    if (s.refreshToken) window.localStorage.setItem(REFRESH_KEY, s.refreshToken);
  } catch {
    /* ignore */
  }
}

/* ── fetch ──────────────────────────────────────────────────── */

type JsonInit = { method?: string; json?: unknown };

let refreshInFlight: Promise<boolean> | null = null;

/** Try once to rotate the refresh token. Returns true on success. */
async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        setSession(null);
        return false;
      }
      const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (!body.accessToken) {
        setSession(null);
        return false;
      }
      setSession({ accessToken: body.accessToken, refreshToken: body.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function raw<T>(path: string, init: JsonInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}/api${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'message' in body) {
        const m = (body as { message: unknown }).message;
        message = typeof m === 'string' ? m : JSON.stringify(m);
      }
    } catch {
      /* non-JSON error — keep the status text */
    }
    throw new ApiError(res.status, message);
  }
  // 204 No Content has no body to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Fetch the backend API. Throws `ApiError` on non-2xx. A 401 triggers one
 * transparent refresh-token rotation + retry before it propagates.
 */
export async function apiFetch<T>(path: string, init: JsonInit = {}): Promise<T> {
  try {
    return await raw<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !path.startsWith('/auth/')) {
      const ok = await tryRefresh();
      if (ok) return raw<T>(path, init);
    }
    throw err;
  }
}
