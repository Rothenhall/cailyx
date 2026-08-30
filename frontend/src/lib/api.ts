/**
 * Thin typed fetch client for the Cailyx backend API.
 * All requests go through `apiFetch`, which attaches the stored bearer token
 * and normalizes NestJS error payloads into `ApiError`.
 *
 * @module lib/api
 */

export const API_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:3002';

/** NestJS error payload shape ({ message, error, statusCode }). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Currently stored access token (per-browser localStorage convenience). */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('cailyx.token');
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem('cailyx.token');
    else window.localStorage.setItem('cailyx.token', token);
  } catch {
    // storage unavailable (private mode) — auth simply won't persist
  }
}

/** JSON-stringified body type for the `json` option. */
type JsonInit = { method?: string; json?: unknown; withToken?: boolean };

/**
 * Fetch the backend API. Throws `ApiError` on non-2xx with the backend's
 * message (validation pipes return arrays — stringified).
 */
export async function apiFetch<T>(path: string, init: JsonInit = {}): Promise<T> {
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
      // non-JSON error — keep the status text
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}