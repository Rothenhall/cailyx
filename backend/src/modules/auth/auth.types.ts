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

/** Claims carried in the (short-lived) access token. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
}

/** Public shape of a user — never exposes passwordHash or token hashes. */
export interface SafeUserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  user: SafeUserDto;
}