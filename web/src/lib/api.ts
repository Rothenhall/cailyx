/**
 * The single HTTP boundary for the app.
 *
 * design_plan.md §10.1 requires page/URL state to reach the backend through a
 * typed service adapter and a same-origin session boundary. Components never
 * call `fetch` directly; they call a `services/*` adapter, which calls this.
 *
 * §10.4's status-code table is implemented once, here, so every screen reacts
 * to a 403 or a 429 the same way instead of inventing its own handling.
 */

/** Requests go to this app's own origin; `next.config.ts` rewrites to NestJS. */
const API_BASE = '/api';

/**
 * §10.4 error classes. The `kind` is what UI switches on — screens should not
 * be re-reading raw status numbers.
 */
export type ApiErrorKind =
  /** 400 — invalid fields or an invalid run configuration. */
  | 'invalid'
  /** 401 — refresh the session, then sign in. */
  | 'unauthenticated'
  /** 403 — access policy. Do NOT retry or refresh on a loop (§3.5). */
  | 'forbidden'
  /** 404 — missing, private, or a prerequisite that has not run yet. Which one
   *  it means is endpoint-specific and the caller must say so in its copy. */
  | 'not-found'
  /** 409 — duplicate, version conflict, or a state conflict. */
  | 'conflict'
  /** 429 — bounded cooldown, honoring Retry-After when present. */
  | 'rate-limited'
  /** 503 — provider or configuration unavailable. */
  | 'unavailable'
  /** The request never completed: offline, DNS, abort, timeout. */
  | 'network'
  /** Anything else. Context is preserved rather than discarded. */
  | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  /** Field-level messages from a 400, keyed by field name. */
  readonly fieldErrors?: Record<string, string[]>;
  /** Seconds to wait, parsed from Retry-After on a 429. */
  readonly retryAfterSeconds?: number;
  /** The decoded response body, kept so a screen can show real server detail. */
  readonly body?: unknown;

  constructor(init: {
    kind: ApiErrorKind;
    status: number;
    message: string;
    fieldErrors?: Record<string, string[]>;
    retryAfterSeconds?: number;
    body?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.fieldErrors = init.fieldErrors;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.body = init.body;
  }
}

function kindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 400:
    case 422:
      return 'invalid';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate-limited';
    case 503:
      return 'unavailable';
    default:
      return 'unknown';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialized as JSON. Omit for GET/DELETE. */
  body?: unknown;
  /** Appended as a query string; `undefined` and `null` values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Cancels an in-flight read — used when the project selector changes so a
   *  late Project A response cannot populate Project B (§10.3). */
  signal?: AbortSignal;
  /** Next.js fetch cache hint. Defaults to no-store: this is live operator
   *  data, and §10.5 forbids putting private responses in a shared cache. */
  cache?: RequestCache;
  /** Server-side only: forward the caller's cookies to the backend. */
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Issues one request and returns the decoded body, or throws an `ApiError`.
 *
 * Callers get a typed result; they do not get a "maybe it's an error object"
 * union, because §10.2 warns that treating an unexpected shape as "no data" is
 * how a failed read silently becomes an empty screen.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, cache = 'no-store', headers = {} } = options;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      signal,
      cache,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    // An aborted request is a deliberate cancellation, not a failure to show.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      kind: 'network',
      status: 0,
      message: 'Could not reach the server. Your work has not been lost.',
      body: cause,
    });
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (response.ok) return parsed as T;

  const payload = (parsed ?? {}) as Record<string, unknown>;
  const retryAfterRaw = response.headers.get('Retry-After');
  const retryAfterSeconds = retryAfterRaw ? Number(retryAfterRaw) : undefined;

  throw new ApiError({
    kind: kindForStatus(response.status),
    status: response.status,
    message:
      (typeof payload.message === 'string' && payload.message) ||
      (Array.isArray(payload.message) && payload.message.join(', ')) ||
      (typeof payload.error === 'string' && payload.error) ||
      `Request failed (${response.status})`,
    fieldErrors: extractFieldErrors(payload),
    retryAfterSeconds:
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds !== undefined
        ? retryAfterSeconds
        : undefined,
    body: parsed,
  });
}

/**
 * NestJS `ValidationPipe` returns `message: string[]` shaped as
 * "field must be ..."; §3.4 requires an error summary that links to the
 * offending field, so the field name is recovered here rather than in a screen.
 */
function extractFieldErrors(payload: Record<string, unknown>): Record<string, string[]> | undefined {
  const messages = payload.message;
  if (!Array.isArray(messages)) return undefined;
  const result: Record<string, string[]> = {};
  for (const entry of messages) {
    if (typeof entry !== 'string') continue;
    const field = entry.split(' ')[0];
    (result[field] ??= []).push(entry);
  }
  return Object.keys(result).length ? result : undefined;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

/**
 * Normalizes the wrapper envelopes Appendix C documents — `{projects}`,
 * `{findings, thinRun}`, `{assets}` and friends.
 *
 * §10.2 is explicit that an unexpected shape must not be interpreted as "no
 * data", so this throws rather than returning `[]` when the key is absent.
 */
export function unwrap<T>(payload: unknown, key: string): T {
  if (payload && typeof payload === 'object' && key in payload) {
    return (payload as Record<string, T>)[key];
  }
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: `Response did not contain the expected "${key}" field.`,
    body: payload,
  });
}
