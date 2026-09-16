/**
 * Auth Types — operator accounts and role-based access (Wave 0).
 *
 * Roles come from the Rothenhall Operating Manual team structure. The role
 * string is echoed into the JWT claims and enforced by RolesGuard.
 *
 * @module auth.types
 */

/** Operator roles. `admin` supersedes all others ("admin sees everything"). */
export type Role = 'admin' | 'delivery-lead' | 'content' | 'technical' | 'outreach' | 'sales';

/** All roles in check order — used by the roles guard and registrations. */
export const ROLES: readonly Role[] = [
  'admin',
  'delivery-lead',
  'content',
  'technical',
  'outreach',
  'sales',
];

/**
 * operator | client — a User row is one or the other, never both. `role` above
 * stays meaningless for a client-type row (left at its default); RolesGuard
 * gates on `type` first, `role` second. See `clients` module.
 */
export type UserType = 'operator' | 'client';

/** Claims carried in the (short-lived) access token. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
  type: UserType;
  /** Present only when type = "client". */
  clientId?: string;
  /**
   * G01 — UserSession.id this token belongs to. Optional so tokens issued
   * before this field existed still verify; a token without it simply can't
   * be pinpointed as "the current session" by change-password/logout-all
   * (those fall back to revoking everything). Every token issued by
   * {@link import('./auth.service').AuthService.issueTokens} carries one.
   */
  sid?: string;
}

/** Public shape of a user — never exposes passwordHash or token hashes. */
export interface SafeUserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  type: UserType;
  clientId: string | null;
  /** G01 — true forces the AU04 first-login security flow client-side. */
  mustChangePassword: boolean;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** G01 — the UserSession this pair belongs to; lets the client mark "this device" in the sessions list without decoding the JWT. */
  sessionId: string;
}

export interface LoginResult extends AuthTokens {
  user: SafeUserDto;
}

/** G01 — one row of `GET /api/auth/sessions`. */
export interface SessionDto {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  deviceLabel: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
  /** True when this is the session the calling access token belongs to. */
  isCurrent: boolean;
}

/** G01 — `GET /api/portal/me`: the client-portal identity shape. Distinct
 * from SafeUserDto because it always carries the Client the login belongs
 * to (never null — a client-type user without one is a data bug, not a
 * valid response shape) and never carries operator-only fields like `role`. */
export interface PortalMeDto {
  id: string;
  email: string;
  name: string;
  type: 'client';
  mustChangePassword: boolean;
  client: {
    id: string;
    name: string;
    status: string;
  };
  createdAt: string;
}