import { api, unwrap } from '@/lib/api';
import type { SafeUser } from './types';

/**
 * Account and session adapter — AU02 (invitation acceptance), AU04 (first-login
 * security) and AU05 (account & sessions).
 *
 * Mirrors `backend/src/modules/auth/auth.controller.ts` and the public
 * acceptance route in `client-access.controller.ts`.
 *
 * **Two boundaries are enforced here rather than in a screen**, because both
 * are security rules a page could otherwise get wrong:
 *
 * 1. **Invitation scope comes from the token, never from the request.** The
 *    acceptance body carries a password and an optional display name —
 *    `acceptInvite` below has no parameter for a role, a clientId or a project
 *    list, so there is nothing a tampered or replayed request could widen.
 *    `member` in the response is what the server decided, read from the stored
 *    token row.
 *
 * 2. **The session the acceptance mints is never handed to page code.** The
 *    route answers with an access/refresh pair. This adapter revokes that pair
 *    server-side (`POST /auth/logout`) and returns only the seat, because this
 *    app stores sessions exclusively in HttpOnly cookies written by a server
 *    route handler (§10.5) and there is no such handler for this route. The
 *    invitee signs in with the password they just set. Dropping the pair here
 *    means no component can accidentally persist a token in page state.
 */

/** One row of `GET /auth/sessions`. */
export interface SessionRow {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  deviceLabel: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
  /** True for the session the calling access token belongs to. */
  isCurrent: boolean;
}

/** What the accept route returns before this adapter strips the tokens. */
interface InviteAcceptedResponse {
  accessToken?: string;
  refreshToken?: string;
  member: ClientMember;
}

/** The seat an invitation created or reactivated. */
export interface ClientMember {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  projectIds: string[];
  status: string;
  invitedBy: string | null;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
}

// ── AU02 — invitation acceptance ────────────────────────────────────────

export interface AcceptInviteInput {
  /** What the invitee chose. The only two fields the server accepts. */
  password: string;
  name?: string;
}

/**
 * Accept an invitation: set a password, redeem the token.
 *
 * The token is single-use and is the credential — an unknown token is a 404,
 * and an expired, revoked or already-accepted one is a 409 telling the invitee
 * to ask for a new invite. There is deliberately **no** preview read here:
 * the backend exposes no unauthenticated route that resolves a token to its
 * organization, which is why the screen renders that identity as an explicit
 * unavailable state rather than guessing it.
 */
export async function acceptInvite(
  token: string,
  input: AcceptInviteInput,
): Promise<{ member: ClientMember }> {
  const response = await api.post<InviteAcceptedResponse>(
    `/invites/${encodeURIComponent(token)}/accept`,
    { password: input.password, name: input.name },
  );

  // Revoke the pair this call minted. Best-effort on purpose: the tokens are
  // discarded either way, and failing to revoke a token nobody holds must not
  // turn a successful acceptance into an error the invitee would retry.
  if (response.refreshToken) {
    try {
      await api.post('/auth/logout', { refreshToken: response.refreshToken });
    } catch {
      // Intentionally swallowed — see above.
    }
  }

  return { member: response.member };
}

// ── Profile ─────────────────────────────────────────────────────────────

/** The signed-in operator's safe profile. Operator accounts only. */
export async function getProfile(options?: { signal?: AbortSignal }): Promise<SafeUser> {
  return api.get<SafeUser>('/auth/me', options);
}

/**
 * Change the caller's own name.
 *
 * `PATCH /users/:id` is the only route that writes a name, and it is
 * admin-only — a non-admin operator has no self-service profile edit in this
 * build. Callers must check `profile.role === 'admin'` and render the reason
 * rather than offering a control that will 403.
 */
export async function updateOwnName(userId: string, name: string): Promise<SafeUser> {
  return api.patch<SafeUser>(`/users/${encodeURIComponent(userId)}`, { name });
}

// ── Passwords ───────────────────────────────────────────────────────────

/**
 * Replace the caller's own password (AU04's temporary-password step, AU05's
 * change-password step).
 *
 * Revokes every **other** live session and clears the forced-first-login flag;
 * the session making the request survives. The returned count is the honest
 * report of what that did — render it, do not assume zero.
 */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ sessionsRevoked: number }> {
  return api.post<{ sessionsRevoked: number }>('/auth/password/change', input);
}

/**
 * Request a reset email. Public and always generic — it never confirms whether
 * the address has an account.
 *
 * This is the recovery path a **client-portal** account has to use: the whole
 * `/auth/*` password surface is operator-only (RolesGuard denies a `type:
 * "client"` token on any non-`@ClientPortal()` route), so a client at AU04
 * cannot change a temporary password from inside the app.
 */
export async function requestPasswordReset(email: string): Promise<{ message?: string }> {
  return api.post<{ message?: string }>('/auth/password/forgot', { email });
}

// ── AU05 — sessions ─────────────────────────────────────────────────────

/** The caller's live sessions, most-recently-seen first. */
export async function listSessions(
  options?: { signal?: AbortSignal },
): Promise<{ sessions: SessionRow[] }> {
  const payload = await api.get<unknown>('/auth/sessions', options);
  const rows = unwrap<SessionRow[]>(payload, 'sessions');
  if (!Array.isArray(rows)) {
    throw new Error('GET /auth/sessions answered with a non-list `sessions` field.');
  }
  return { sessions: rows };
}

/** Revoke one session (and its correlated refresh token). */
export async function revokeSession(sessionId: string): Promise<{ revoked: boolean }> {
  return api.delete<{ revoked: boolean }>(`/auth/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * Sign out of every device, including this one.
 *
 * This is a **server call**, not a local cookie clear: only the backend can
 * revoke refresh tokens it never handed to the browser. A screen that merely
 * cleared cookies would leave every other device signed in.
 */
export async function signOutEverywhere(): Promise<{ sessionsRevoked: number }> {
  return api.post<{ sessionsRevoked: number }>('/auth/logout-all');
}
