/**
 * Thin typed fetch client for the Cailyx backend API.
 *
 * - attaches the stored bearer token
 * - on a 401, transparently rotates the refresh token once and retries, so a
 *   session survives well past the 15-minute access-token TTL
 * - normalizes NestJS error payloads into `ApiError`
 * - `cacheGet` / `cacheSet` persist last-known fetched payloads in localStorage
 *   so the UI can render instantly on reload while the fresh copy loads
 *
 * @module lib/api
 */

export const API_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:3002';

const TOKEN_KEY = 'cailyx.token';
const REFRESH_KEY = 'cailyx.refresh';

/** NestJS error payload shape ({ message, error, statusCode }). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/* ── token store ─────────────────────────────────────────────── */

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
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

/** Store an access + refresh pair (call after login / refresh). */
export function setSession(s: { accessToken: string; refreshToken?: string | null } | null): void {
  if (s === null) {
    setToken(null);
    try {
      window.localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  setToken(s.accessToken);
  try {
    if (s.refreshToken) window.localStorage.setItem(REFRESH_KEY, s.refreshToken);
  } catch {
    /* ignore */
  }
}

/* ── payload cache (last-known-good) ─────────────────────────── */

export function cacheGet<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`cailyx.cache.${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function cacheSet(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`cailyx.cache.${key}`, JSON.stringify(value));
  } catch {
    /* quota / unavailable — non-fatal */
  }
}

export function cacheClearProject(projectId: string): void {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('cailyx.cache.') && k.includes(projectId)) window.localStorage.removeItem(k);
    }
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
