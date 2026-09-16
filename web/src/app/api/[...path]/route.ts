import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookies, getAccessToken, getRefreshToken, setSessionCookies } from '@/lib/session';

/**
 * The browser's single door to the backend.
 *
 * A plain Next rewrite cannot work here: the session lives in `HttpOnly`
 * cookies, so nothing in the page can turn it into an `Authorization` header.
 * This handler does that server-side, which is what keeps the refresh token out
 * of reach of page JavaScript.
 *
 * It also owns the §10.3 refresh race: a 401 triggers **one** rotation and a
 * single replay of the original request, so a burst of calls that all expire
 * together produces one rotation rather than a cascade of competing ones.
 *
 * `/api/session/*` is handled by its own more specific route handlers and never
 * reaches here.
 */

const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://localhost:3002';

/** Bodyless by spec — forwarding a body on these is what trips some proxies. */
const BODYLESS = new Set(['GET', 'HEAD']);

/** Hop-by-hop and identity headers we must not blindly forward upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'cookie',
  'authorization',
  'accept-encoding',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

/** Serializes rotation per refresh token, same reasoning as the refresh route. */
const inFlightRefresh = new Map<string, Promise<boolean>>();

async function refreshOnce(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return false;

  const existing = inFlightRefresh.get(refreshToken);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const upstream = await fetch(`${BACKEND}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        cache: 'no-store',
      });
      if (!upstream.ok) {
        await clearSessionCookies();
        return false;
      }
      const body = (await upstream.json().catch(() => ({}))) as {
        accessToken?: string;
        refreshToken?: string;
        user?: { type?: string };
      };
      if (!body.accessToken || !body.refreshToken) {
        await clearSessionCookies();
        return false;
      }
      await setSessionCookies({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        userType: body.user?.type === 'client' ? 'client' : 'operator',
      });
      return true;
    } catch {
      // A network failure is not proof the session is invalid, so the cookies
      // are left alone and the caller sees the upstream error instead.
      return false;
    } finally {
      inFlightRefresh.delete(refreshToken);
    }
  })();

  inFlightRefresh.set(refreshToken, pending);
  return pending;
}

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const target = `${BACKEND}/api/${path.join('/')}${request.nextUrl.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  // Read the body once; a retry after refresh needs to send it again.
  const body = BODYLESS.has(request.method) ? undefined : await request.arrayBuffer();

  const send = async (token: string | null): Promise<Response> => {
    const attempt = new Headers(headers);
    if (token) attempt.set('Authorization', `Bearer ${token}`);
    return fetch(target, {
      method: request.method,
      headers: attempt,
      body: body && body.byteLength > 0 ? body : undefined,
      cache: 'no-store',
      redirect: 'manual',
    });
  };

  let upstream: Response;
  try {
    upstream = await send(await getAccessToken());
  } catch {
    return NextResponse.json(
      { message: 'Could not reach the server. Your work has not been lost.' },
      { status: 503 },
    );
  }

  if (upstream.status === 401 && (await refreshOnce())) {
    try {
      upstream = await send(await getAccessToken());
    } catch {
      return NextResponse.json({ message: 'Could not reach the server.' }, { status: 503 });
    }
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: Context) {
  return proxy(request, (await ctx.params).path);
}
export async function POST(request: NextRequest, ctx: Context) {
  return proxy(request, (await ctx.params).path);
}
export async function PUT(request: NextRequest, ctx: Context) {
  return proxy(request, (await ctx.params).path);
}
export async function PATCH(request: NextRequest, ctx: Context) {
  return proxy(request, (await ctx.params).path);
}
export async function DELETE(request: NextRequest, ctx: Context) {
  return proxy(request, (await ctx.params).path);
}
