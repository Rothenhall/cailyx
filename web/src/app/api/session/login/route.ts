import { NextResponse } from 'next/server';
import { setSessionCookies } from '@/lib/session';

/**
 * Sign-in boundary.
 *
 * The browser posts credentials here, not to NestJS. This handler exchanges
 * them for a token pair server-side and puts the tokens in HttpOnly cookies, so
 * the refresh token is never reachable from page JavaScript.
 *
 * Route handlers are matched before the `/api/*` rewrite in `next.config.ts`,
 * so this path shadows the proxied backend route deliberately.
 */

const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://localhost:3002';

export async function POST(request: Request) {
  let payload: { email?: string; password?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ message: 'Expected a JSON body.' }, { status: 400 });
  }

  const { email, password } = payload;
  if (!email || !password) {
    return NextResponse.json(
      { message: 'Enter your email address and password.' },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { message: 'Could not reach the sign-in service. Try again in a moment.' },
      { status: 503 },
    );
  }

  const body = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    // Pass the backend's status through unchanged. In particular a 401 here
    // must stay a generic credential failure: it never reveals whether the
    // address exists.
    return NextResponse.json(body, { status: upstream.status });
  }

  const { accessToken, refreshToken, user } = body as {
    accessToken?: string;
    refreshToken?: string;
    user?: { type?: string; mustChangePassword?: boolean };
  };

  if (!accessToken || !refreshToken || !user) {
    return NextResponse.json(
      { message: 'Sign-in succeeded but the response was incomplete.' },
      { status: 502 },
    );
  }

  await setSessionCookies({
    accessToken,
    refreshToken,
    userType: user.type === 'client' ? 'client' : 'operator',
  });

  // Only the safe profile crosses back to the browser — never the tokens.
  return NextResponse.json({ user });
}
