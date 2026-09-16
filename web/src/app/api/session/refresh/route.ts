import { NextResponse } from 'next/server';
import { clearSessionCookies, getRefreshToken, setSessionCookies } from '@/lib/session';

/**
 * Refresh boundary.
 *
 * design_plan.md §11.2 case 3 requires that simultaneous requests during an
 * expiry do not each rotate the token — a rotating refresh token means the
 * second rotation would invalidate the first and sign the user out.
 *
 * Refresh is serialized per server instance by the in-flight promise below.
 * That is sufficient for the single-instance deployment this app targets; a
 * multi-instance deployment needs a shared lock, which is noted here rather
 * than pretended.
 */

const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://localhost:3002';

/** Keyed by refresh token so two different sessions still refresh independently. */
const inFlight = new Map<string, Promise<Response>>();

async function rotate(refreshToken: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { message: 'Could not reach the session service.' },
      { status: 503 },
    );
  }

  const body = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    // The refresh token is spent or revoked: the session is genuinely over.
    await clearSessionCookies();
    return NextResponse.json(body, { status: 401 });
  }

  const { accessToken, refreshToken: nextRefresh, user } = body as {
    accessToken?: string;
    refreshToken?: string;
    user?: { type?: string };
  };

  if (!accessToken || !nextRefresh) {
    await clearSessionCookies();
    return NextResponse.json({ message: 'Session could not be renewed.' }, { status: 401 });
  }

  await setSessionCookies({
    accessToken,
    refreshToken: nextRefresh,
    userType: user?.type === 'client' ? 'client' : 'operator',
  });

  return NextResponse.json({ ok: true });
}

export async function POST() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    return NextResponse.json({ message: 'No session to renew.' }, { status: 401 });
  }

  const existing = inFlight.get(refreshToken);
  if (existing) {
    // A concurrent caller is already rotating this exact token. Wait for that
    // result instead of starting a second rotation that would invalidate it.
    const result = await existing;
    return result.clone();
  }

  const pending = rotate(refreshToken).finally(() => {
    inFlight.delete(refreshToken);
  });
  inFlight.set(refreshToken, pending);

  const result = await pending;
  return result.clone();
}
