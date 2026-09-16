import { api, unwrap } from '@/lib/api';

/**
 * Client-side access adapter (design_plan G02) — CP14 "collaborators" and
 * CP05 "connections".
 *
 * Routes: `@ClientPortal()` controllers in
 * `backend/src/modules/client-access/client-access.controller.ts`
 * (`portal/members`, `portal/invites`,
 * `portal/projects/:projectId/integrations/google`). The client is resolved
 * from the session in every case, and the Google group resolves the caller's
 * **seat** and checks the project against that seat's scope — so a
 * collaborator scoped to one project cannot reach a sibling project even
 * within the same client.
 *
 * ## Two rules encoded in the types
 *
 * 1. **Seat management needs a `client-admin` seat.** Reads are open to every
 *    seat; create/update/revoke/invite are not. The server enforces this with a
 *    403 — the wire type cannot express it, so callers must handle the 403
 *    rather than assume the control they rendered will work.
 * 2. **Whose Google grant it is, is not the client's business beyond their own
 *    account.** `ScopedGoogleConnectionDto.ownerUserId`, `DelegationDto`'s
 *    `granteeUserId`/`grantedBy` and `ConnectionImpactDto`'s per-delegate ids
 *    are raw `User.id`s. They are absent from the interfaces below, so a screen
 *    cannot render one: this surface shows *that* someone is delegated and how
 *    many people are affected, never who.
 *
 * @module services/portal-access
 */

export type PortalMemberRole = 'client-admin' | 'client-collaborator' | 'client-viewer';

export const PORTAL_MEMBER_ROLE_LABEL: Record<PortalMemberRole, string> = {
  'client-admin': 'Administrator',
  'client-collaborator': 'Collaborator',
  'client-viewer': 'Viewer',
};

export const PORTAL_MEMBER_ROLE_DESCRIPTION: Record<PortalMemberRole, string> = {
  'client-admin': 'Can manage people, invitations and this account’s connections.',
  'client-collaborator': 'Can read and act on the projects in their scope.',
  'client-viewer': 'Read only.',
};

export interface PortalMember {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  name: string;
  role: PortalMemberRole;
  /** Empty = every project of this client. */
  projectIds: string[];
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface PortalInvite {
  id: string;
  clientId: string;
  email: string;
  role: PortalMemberRole;
  /** Empty = every project of this client. */
  projectIds: string[];
  /** Derived by the server — never "expiresAt compared to the browser clock". */
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
}

/**
 * Returned **exactly once**, on creation.
 *
 * `token`/`acceptUrl` are the invitation credential: the raw token is never
 * retrievable again, and §5.1 forbids putting a bearer credential in a URL this
 * app navigates to or logs. A screen shows them once, for the inviter to hand
 * over, and never stores them.
 *
 * `emailSent`/`emailError` report the delivery attempt honestly — an invitation
 * whose email failed still exists, and saying so is the difference between
 * "they have no invite" and "they have an invite you must relay".
 */
export interface PortalInviteCreated extends PortalInvite {
  token: string;
  acceptUrl: string;
  emailSent: boolean;
  emailError: string | null;
}

// ── Seats ───────────────────────────────────────────────────────────────

export async function listPortalMembers(options?: { signal?: AbortSignal }) {
  const payload = await api.get<unknown>('/portal/members', options);
  return unwrap<PortalMember[]>(payload, 'members');
}

export async function createPortalMember(input: {
  userId: string;
  role?: PortalMemberRole;
  projectIds?: string[];
}) {
  return api.post<PortalMember>('/portal/members', input);
}

export async function updatePortalMember(
  memberId: string,
  input: { role?: PortalMemberRole; projectIds?: string[]; status?: 'active' | 'suspended' },
) {
  return api.patch<PortalMember>(`/portal/members/${encodeURIComponent(memberId)}`, input);
}

/** A soft delete server-side: the seat keeps its history, it just stops working. */
export async function revokePortalMember(memberId: string) {
  return api.delete<{ ok: true }>(`/portal/members/${encodeURIComponent(memberId)}`);
}

// ── Invitations ─────────────────────────────────────────────────────────

export async function listPortalInvites(options?: { signal?: AbortSignal }) {
  const payload = await api.get<unknown>('/portal/invites', options);
  return unwrap<PortalInvite[]>(payload, 'invites');
}

export async function createPortalInvite(input: {
  email: string;
  role?: PortalMemberRole;
  projectIds?: string[];
}) {
  return api.post<PortalInviteCreated>('/portal/invites', input);
}

export async function revokePortalInvite(inviteId: string) {
  return api.delete<{ ok: true }>(`/portal/invites/${encodeURIComponent(inviteId)}`);
}

// ── Google: the client's own grant, mapped to their own project ─────────

export type PortalGoogleService = 'search-console' | 'analytics';

export const PORTAL_GOOGLE_SERVICE_LABEL: Record<PortalGoogleService, string> = {
  'search-console': 'Google Search Console',
  analytics: 'Google Analytics',
};

export interface PortalGoogleConnection {
  /**
   * Null when no connection reaches this caller for this service — the same
   * situation as `access: 'none'`. It must never render as
   * "connected but broken".
   */
  connectionId: string | null;
  service: PortalGoogleService;
  /** `owner` — you authorized it; `delegated` — someone granted you access; `none`. */
  access: 'owner' | 'delegated' | 'none';
  accessLevel: 'read' | 'read-write' | null;
  /** The Google account the grant belongs to, when known. */
  googleEmail: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  /** The provider's last error string. Shown only when it is safe to show — see the CP05 note. */
  lastError: string | null;
  mappedResourceId: string | null;
  mappedResourceLabel: string | null;
}

export interface PortalGoogleResourceOption {
  /** GSC siteUrl, or `properties/123456789`. The exact identifier, never a label alone. */
  id: string;
  label: string;
  /** Extra identifying context, e.g. the GSC permission level. */
  detail?: string;
}

export interface PortalGoogleResources {
  service: PortalGoogleService;
  projectId: string;
  /** True when the provider call succeeded — an empty `options` with `connected: true` means the provider returned nothing, not that the mapping was cleared. */
  connected: boolean;
  options: PortalGoogleResourceOption[];
  selected: { resourceId: string; resourceLabel: string | null } | null;
  /** True for a delegated grantee: they may see the mapping but not browse or change someone else's account. */
  readOnly: boolean;
}

export interface PortalGoogleImpact {
  connectionId: string;
  service: PortalGoogleService;
  /** Projects of this client whose mapping would go dark. */
  affectedProjects: Array<{ projectId: string; resourceId: string; resourceLabel: string | null }>;
  /** Other people who would lose access, counted — their ids are not shown. */
  affectedDelegates: Array<{ projectId: string; accessLevel: 'read' | 'read-write' }>;
}

export interface PortalGoogleDateWindow {
  startDate: string;
  endDate: string;
  days: number;
}

export interface PortalSearchConsoleSummary {
  range: PortalGoogleDateWindow;
  site: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
  topPages: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
}

export interface PortalAnalyticsSummary {
  range: PortalGoogleDateWindow;
  property: string;
  totals: {
    sessions: number;
    totalUsers: number;
    screenPageViews: number;
    engagementRate: number;
    averageSessionDuration: number;
  };
  channels: Array<{ key: string; sessions: number; totalUsers: number }>;
  topPages: Array<{ key: string; screenPageViews: number; sessions: number }>;
}

export type PortalGoogleSummary = PortalSearchConsoleSummary | PortalAnalyticsSummary;

/** Whether the server holds Google OAuth credentials at all. False means nothing else here can work. */
export async function getPortalGoogleStatus(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<{ configured: boolean }>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/status`,
    options,
  );
}

/**
 * Per-service state, **returned as a bare array** rather than an envelope.
 *
 * Both shapes are accepted, and anything else throws: §10.2 is explicit that an
 * unexpected response shape must not be read as "no data" — a silently empty
 * connection list would tell a client they are not connected when in fact the
 * page could not read the answer.
 */
export async function listPortalGoogleConnections(
  projectId: string,
  options?: { signal?: AbortSignal },
) {
  const payload = await api.get<unknown>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/connections`,
    options,
  );
  if (Array.isArray(payload)) return payload as PortalGoogleConnection[];
  return unwrap<PortalGoogleConnection[]>(payload, 'connections');
}

export async function getPortalGoogleResources(
  projectId: string,
  service: PortalGoogleService,
  options?: { signal?: AbortSignal },
) {
  return api.get<PortalGoogleResources>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/resources`,
    { ...options, query: { service } },
  );
}

/**
 * The Google consent URL to send the browser to.
 *
 * The resulting connection is owned by the person who completes consent — the
 * project id travels only as context for the resource picker.
 */
export async function authorizePortalGoogle(
  projectId: string,
  service: PortalGoogleService,
) {
  return api.post<{ url: string }>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/authorize`,
    { service },
  );
}

export async function setPortalGoogleResource(
  projectId: string,
  input: { service: PortalGoogleService; resourceId: string; resourceLabel?: string },
) {
  return api.put<{ ok: true }>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/resources`,
    input,
  );
}

export async function getPortalGoogleImpact(
  projectId: string,
  connectionId: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<PortalGoogleImpact>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/connections/${encodeURIComponent(connectionId)}/impact`,
    options,
  );
}

/**
 * Disconnects the caller's own Google connection for one service.
 *
 * Cascades the project-resource mappings and revokes every live delegation on
 * that connection; the response is that impact rather than a bare `ok`, so the
 * caller is told what just went dark. Null when the caller has no connection
 * for this service.
 */
export async function disconnectPortalGoogle(projectId: string, service: PortalGoogleService) {
  return api.delete<PortalGoogleImpact | null>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/connections/${encodeURIComponent(service)}`,
  );
}

/**
 * A real read through the mapped resource, to prove the mapping works.
 *
 * Proxied server-side using the connection owner's stored token; the caller
 * never sees that token. A failed read is reported as a failure, never as
 * zeros. Deliberately explicit rather than fired on page load: this is the
 * action that moves a mapping from "configured" to "verified".
 */
export async function testPortalGoogleRead(
  projectId: string,
  service: PortalGoogleService,
  days = 28,
) {
  return api.get<PortalGoogleSummary>(
    `/portal/projects/${encodeURIComponent(projectId)}/integrations/google/test-read`,
    { query: { service, days } },
  );
}
