import { NextResponse } from 'next/server';
import { clearSessionCookies, getRefreshToken } from '@/lib/session';

/**
 * Sign-out boundary.
 *
 * The local session is cleared even if the backend revocation call fails: a
 * user who clicked "sign out" must end up signed out of this browser
 * regardless. The backend outcome is reported separately so the UI can be
 * honest about server-side revocation (design_plan §3.5, failed-send row).
 */

const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://localhost:3002';

export async function POST() {
  const refreshToken = await getRefreshToken();
  let revoked = false;

  if (refreshToken) {
    try {
      const upstream = await fetch(`${BACKEND}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        cache: 'no-store',
      });
      revoked = upstream.ok;
    } catch {
      revoked = false;
    }
  }

  await clearSessionCookies();
  return NextResponse.json({ ok: true, serverRevoked: revoked });
}
