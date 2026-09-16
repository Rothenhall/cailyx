/**
 * ClientAccess — shared types (G02).
 *
 * Two families of resource live in this module:
 * 1. Seats/invitations: `ClientMember` (who may sign into a client's portal,
 *    with what role and project scope) and invite `AuthToken`s (purpose
 *    "invite") that turn into a `ClientMember` + `User` row on acceptance.
 * 2. Delegated Google connections: a `GoogleConnection` is owned by exactly
 *    one `User` (operator or client — the google module does not care which).
 *    A `ConnectionDelegation` lets a second user (operator or client
 *    collaborator) use that connection's data without ever holding its
 *    tokens — every delegated read is proxied through this module using the
 *    OWNER's userId, never the grantee's.
 *
 * @module client-access.types
 */

/** client-admin manages seats/invites/connections; client-collaborator has
 *  scoped project access; client-viewer is read-only. Meaningless for
 *  operator-type Users (mirrors how `role` is meaningless for type=client
 *  elsewhere in this codebase — see auth.types.ts). */
export type ClientMemberRole = 'client-admin' | 'client-collaborator' | 'client-viewer';
export const CLIENT_MEMBER_ROLES: readonly ClientMemberRole[] = ['client-admin', 'client-collaborator', 'client-viewer'];

export type ClientMemberStatus = 'active' | 'suspended';

/** `ConnectionDelegation.accessLevel`. */
export type DelegationAccessLevel = 'read' | 'read-write';

export interface ClientMemberDto {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  name: string;
  role: ClientMemberRole;
  /** Empty = "all of this client's projects" — see the model comment. */
  projectIds: string[];
  status: ClientMemberStatus;
  invitedBy: string | null;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
}

/** A client the resolved caller may act as — used internally, never returned as-is. */
export interface ResolvedMembership {
  clientId: string;
  userId: string;
  role: ClientMemberRole;
  /** Empty = all projects of this client. */
  projectIds: string[];
  status: ClientMemberStatus;
  /** True when there is no ClientMember row yet for this client-type User
   *  (every login created before G02 shipped, via `POST /clients/:id/login`).
   *  Treated as a full-scope client-admin so existing logins are not locked
   *  out; a real ClientMember row should be backfilled the first time an
   *  operator manages seats for that client. */
  legacy: boolean;
}

export interface InviteDto {
  id: string;
  clientId: string;
  email: string;
  role: ClientMemberRole;
  projectIds: string[];
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
  createdBy: string | null;
  createdAt: string;
}

/** Returned exactly once, on creation — the raw token never lands in storage. */
export interface InviteCreatedDto extends InviteDto {
  token: string;
  acceptUrl: string;
  emailSent: boolean;
  emailError: string | null;
}

export interface InviteAcceptedDto {
  accessToken: string;
  refreshToken: string;
  member: ClientMemberDto;
}

/* ── delegated Google connections ─────────────────────────────────────── */

export interface ScopedGoogleConnectionDto {
  /** The connection that actually serves this project: the project's mapped
   *  resource, else the caller's own grant. `null` when neither exists — which
   *  is the same situation as `access: "none"`, and must never be rendered as
   *  a connected-but-broken state. */
  connectionId: string | null;
  service: 'search-console' | 'analytics';
  /** Whose grant this is — never the tokens themselves. */
  ownerUserId: string;
  /** "owner" — the caller authorized it themselves; "delegated" — someone
   *  else authorized it and granted the caller access; "none" — no
   *  connection reaches this caller for this service. */
  access: 'owner' | 'delegated' | 'none';
  accessLevel: DelegationAccessLevel | null;
  googleEmail: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  lastError: string | null;
  mappedResourceId: string | null;
  mappedResourceLabel: string | null;
}

export interface ConnectionImpactDto {
  connectionId: string;
  service: 'search-console' | 'analytics';
  ownerUserId: string;
  /** Projects (within the caller's own client, for the portal surface) whose
   *  resource mapping is served by this connection and would go dark. */
  affectedProjects: Array<{ projectId: string; resourceId: string; resourceLabel: string | null }>;
  /** Other users who currently hold a live delegation on this connection and
   *  would lose access. */
  affectedDelegates: Array<{ granteeUserId: string; projectId: string; accessLevel: DelegationAccessLevel }>;
}

export interface DelegationDto {
  id: string;
  connectionId: string;
  projectId: string;
  granteeUserId: string;
  grantedBy: string;
  accessLevel: DelegationAccessLevel;
  revokedAt: string | null;
  createdAt: string;
}
