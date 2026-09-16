import 'server-only';
import { cookies } from 'next/headers';

/**
 * Server-side session handling.
 *
 * The NestJS backend issues a JWT access/refresh pair as **JSON**. Handing those
 * to browser JavaScript would put a long-lived refresh token in reach of any XSS
 * on the page, so this app never does that: the tokens are held in `HttpOnly`
 * cookies set by this app's own route handlers, and the browser only ever talks
 * to this origin (`next.config.ts` rewrites `/api/*` onward to NestJS).
 *
 * design_plan.md §10.5 calls this out as an implementation requirement rather
 * than something the backend provides today — this module is that
 * implementation.
 */

const ACCESS_COOKIE = 'cailyx_at';
const REFRESH_COOKIE = 'cailyx_rt';
/** Mirrors the session type so a layout can route without decoding the JWT. */
const TYPE_COOKIE = 'cailyx_type';

/** design_plan §5.1: the access token is short-lived; the refresh token is not. */
const ACCESS_MAX_AGE_SECONDS = 60 * 15;
const REFRESH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type SessionUserType = 'operator' | 'client';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  userType: SessionUserType;
}

const baseCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

/** Writes the session cookies after a successful sign-in or refresh. */
export async function setSessionCookies(tokens: SessionTokens): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, {
    ...baseCookieOptions,
    maxAge: ACCESS_MAX_AGE_SECONDS,
  });
  jar.set(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseCookieOptions,
    maxAge: REFRESH_MAX_AGE_SECONDS,
  });
  // Readable by the server only; it is a routing hint, not an authorization
  // input. Access decisions are made by the backend from the JWT itself.
  jar.set(TYPE_COOKIE, tokens.userType, {
    ...baseCookieOptions,
    maxAge: REFRESH_MAX_AGE_SECONDS,
  });
}

/** Clears the session. Used by sign-out and by an unrecoverable refresh failure. */
export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, TYPE_COOKIE]) {
    jar.set(name, '', { ...baseCookieOptions, maxAge: 0 });
  }
}

export async function getAccessToken(): Promise<string | null> {
  return (await cookies()).get(ACCESS_COOKIE)?.value ?? null;
}

export async function getRefreshToken(): Promise<string | null> {
  return (await cookies()).get(REFRESH_COOKIE)?.value ?? null;
}

export async function getSessionUserType(): Promise<SessionUserType | null> {
  const value = (await cookies()).get(TYPE_COOKIE)?.value;
  return value === 'operator' || value === 'client' ? value : null;
}

/**
 * Authorization header for a server-side call to the backend.
 *
 * Server Components call the backend directly (not through the browser), so
 * they attach the token themselves rather than relying on cookie forwarding.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
