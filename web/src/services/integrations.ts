import { api } from '@/lib/api';

/**
 * Google connection adapter (Appendix C.6) — design_plan.md screen PJ03
 * "Connections" and PJ04 "Google resource picker".
 *
 * The connections layout family in §4 states the contract precisely: *"Service
 * cards show authorization, mapped resource and last tested read
 * **independently**."*
 *
 * Three separate facts, three separate fields — this module keeps them apart
 * on the wire so no screen can collapse them into one green tick:
 *
 *   - `status`      — is the OAuth client configured on this server at all?
 *   - `connections` — has an account actually granted access?
 *   - `resources`   — has a specific site/property been mapped to the project?
 *
 * A connection with no mapped resource is the §3.5 "OAuth connected, resource
 * unmapped" state, and it must never read as ready.
 */

export interface GoogleServiceStatus {
  /** Whether the server has an OAuth client id/secret configured. */
  configured: boolean;
  /** The scopes the current grant holds, as recorded. */
  scopes?: string[];
  /** Whatever the backend reports as the current state description. */
  detail?: string;
}

export interface GoogleConnection {
  service: string;
  /** Present once an account has granted access. */
  connectedAt?: string | null;
  /** The Google account the grant belongs to, when known. */
  accountEmail?: string | null;
  scope?: string[] | null;
  /** Whether a usable refresh grant is stored. */
  hasGrant?: boolean;
}

export interface GoogleResourceMapping {
  projectId: string;
  service: string;
  /** The specific GSC site or GA4 property mapped. */
  resourceId: string;
  resourceLabel?: string | null;
}

export interface GoogleResourceOption {
  id: string;
  label: string;
  /** Extra identifying context, e.g. the GSC permission level. */
  detail?: string;
}

export async function getGoogleStatus(options?: { signal?: AbortSignal }) {
  return api.get<GoogleServiceStatus>('/integrations/google/status', options);
}

export async function getGoogleConnections(options?: { signal?: AbortSignal }) {
  return api.get<{ connections: GoogleConnection[] }>('/integrations/google/connections', options);
}

/**
 * ⚠️ Superseded by {@link getGoogleResourcesView} — kept only so the name
 * resolves. The route does **not** answer `{ resources }`; it answers a view
 * (`{ service, projectId, connected, options, selected }`), where
 * `connected: false` means the account could not be read for this service.
 * That is a state, not an error, and the flat `{ resources }` shape cannot
 * express it. Prefer the view.
 *
 * @deprecated use `getGoogleResourcesView`
 */
export async function listGoogleResources(
  input: { service: 'search-console' | 'analytics'; projectId?: string },
  options?: { signal?: AbortSignal },
) {
  return api.get<{ resources: GoogleResourceOption[] }>('/integrations/google/resources', {
    ...options,
    query: input,
  });
}

/**
 * Maps a project to one specific site or property.
 *
 * The picker must show the exact identifier (§4 connections family: "selection
 * dialog shows exact property/site identifier") — a label alone is not enough
 * to tell two similarly named properties apart, and mapping the wrong one
 * produces plausible-looking but wrong data.
 */
export async function mapGoogleResource(input: {
  projectId: string;
  service: 'search-console' | 'analytics';
  resourceId: string;
}) {
  return api.put<void>('/integrations/google/resources', input);
}

/**
 * Revokes a grant.
 *
 * The caller must first read the impact (which projects lose data) and present
 * it — §4 requires a "disconnect flow presents known impact" rather than a
 * bare confirm.
 */
export async function disconnectGoogle(service: 'search-console' | 'analytics') {
  return api.delete<void>(`/integrations/google/connections/${service}`);
}

/**
 * The OAuth consent URL to send the operator to.
 *
 * The route returns **`{ url }`**, not `{ authorizationUrl }`. That is not a
 * detail: an earlier version of this function read `authorizationUrl`, so the
 * value was `undefined` and the connect button navigated the operator to
 * `/undefined`. The field name is the whole contract here.
 */
export async function beginGoogleAuthorization(input: {
  service: 'search-console' | 'analytics';
  projectId?: string;
  /** Where Google should return the operator afterwards. */
  returnTo?: string;
}) {
  return api.post<{ url: string }>('/integrations/google/authorize', input);
}

/**
 * Probes the grant by performing a real read.
 *
 * §3.5 distinguishes "credentials configured but runtime unverified" from a
 * working connection, and this is what moves a connection from the first state
 * to the second. It is deliberately a separate, explicit action rather than
 * something a page does on load.
 */
export async function testGoogleRead(input: {
  service: 'search-console' | 'analytics';
  projectId?: string;
  days?: number;
}) {
  if (input.service === 'search-console') {
    return api.get<Record<string, unknown>>('/integrations/google/search-console/summary', {
      query: { projectId: input.projectId, days: input.days },
    });
  }
  return api.get<Record<string, unknown>>('/integrations/google/analytics/summary', {
    query: { projectId: input.projectId, days: input.days },
  });
}

// ── PJ04 — the Google resource picker's real wire shapes ────────────────
//
// The functions above were written against an assumed envelope. The actual
// contract (google.types.ts / google.dto.ts) is different in three ways that
// matter, so the correct reads live here rather than replacing them — the
// existing connections screen still imports the originals:
//
//   1. `POST /integrations/google/authorize` returns `{ url }`, not
//      `{ authorizationUrl }`.
//   2. `GET /integrations/google/resources` returns
//      `{ service, projectId, connected, options, selected }` — a view, not a
//      bare `{ resources }` wrapper. `connected: false` (the account cannot be
//      read for this service) is a *state*, not an error.
//   3. `GoogleConnectionView` is a fixed per-service row that always exists,
//      carrying `googleEmail`, `expiresAt`, `expired` and `lastError` — so
//      "connected" is distinguishable from "connected but the grant expired".

/**
 * The authoritative per-service connection row.
 *
 * Always two rows, one per service; `connected: false` is the honest "no
 * grant" state. `expired` and `lastError` are separate from `connected`
 * because a stored grant that Google will no longer honour is exactly the
 * §3.5 "configured but runtime unverified" case, and collapsing it into
 * "connected" would show a working connection that is not one.
 */
export interface GoogleConnectionView {
  service: 'search-console' | 'analytics';
  connected: boolean;
  /** The Google account the grant belongs to, when known. */
  googleEmail: string | null;
  scope: string;
  connectedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  lastError: string | null;
}

export async function listGoogleConnectionViews(
  options?: { signal?: AbortSignal },
): Promise<GoogleConnectionView[]> {
  return api.get<GoogleConnectionView[]>('/integrations/google/connections', options);
}

/** A GSC site or GA4 property the connected account can read. */
export interface GoogleResourceChoice {
  /** The GSC `siteUrl`, or a GA4 `"properties/123456789"` id. */
  id: string;
  label: string;
  /** Extra identifying context, e.g. the permission level. */
  detail?: string;
}

/**
 * What the picker needs: the choices, the current mapping, and whether the
 * account can be read at all for this service.
 *
 * `connected: false` means the resource list could not be fetched — the
 * account is not authorized for this service, or the grant failed. It is
 * deliberately *not* an exception, because §3.5 requires "OAuth connected,
 * resource unmapped" and "authorization failed" to be two different screens.
 */
export interface GoogleResourcesView {
  service: 'search-console' | 'analytics';
  projectId: string;
  connected: boolean;
  options: GoogleResourceChoice[];
  /** The current mapping, or null when nothing is mapped yet. */
  selected: { resourceId: string; resourceLabel: string | null } | null;
}

export async function getGoogleResourcesView(
  input: { service: 'search-console' | 'analytics'; projectId: string },
  options?: { signal?: AbortSignal },
): Promise<GoogleResourcesView> {
  return api.get<GoogleResourcesView>('/integrations/google/resources', {
    ...options,
    query: input,
  });
}

/**
 * Maps a project to one exact site or property.
 *
 * `resourceId` is the identifier, never the label — two GSC properties can
 * carry the same label, and mapping the wrong one produces plausible-looking
 * but wrong data. `resourceLabel` is stored alongside purely so the mapping
 * can be displayed without a second lookup.
 *
 * A 409 here means no Google connection exists for the service yet: connect
 * first, then choose. It is not a retryable failure.
 */
export async function putGoogleResource(input: {
  service: 'search-console' | 'analytics';
  projectId: string;
  resourceId: string;
  resourceLabel?: string | null;
}) {
  return api.put<{ ok: true }>('/integrations/google/resources', {
    service: input.service,
    projectId: input.projectId,
    resourceId: input.resourceId,
    ...(input.resourceLabel ? { resourceLabel: input.resourceLabel } : {}),
  });
}

/**
 * The OAuth consent URL, returned as `{ url }` — the real field name.
 *
 * Full navigation, not a popup: the consent screen has to be unmistakably
 * Google's own, and a blocked popup fails silently.
 */
export async function getGoogleAuthorizationUrl(input: {
  service: 'search-console' | 'analytics';
  projectId?: string;
}) {
  return api.post<{ url: string }>('/integrations/google/authorize', input);
}

/**
 * Reads the service's summary for the project's mapped resource.
 *
 * This is the "test read": it goes through `requireProjectResource` on the
 * server, so it fails with a 404 naming the unmapped prerequisite rather than
 * silently reading nothing. It is deliberately an explicit operator action and
 * never a page-load probe — §3.5 keeps "configured" and "verified working"
 * apart, and only a real read moves the second one.
 */
export async function readGoogleSummary(
  input: { service: 'search-console' | 'analytics'; projectId: string; days?: number },
  options?: { signal?: AbortSignal },
) {
  const path =
    input.service === 'search-console'
      ? '/integrations/google/search-console/summary'
      : '/integrations/google/analytics/summary';
  return api.get<Record<string, unknown>>(path, {
    ...options,
    query: { projectId: input.projectId, days: input.days },
  });
}

/** Whether the server has an OAuth client id/secret at all. */
export async function getGoogleConfigured(options?: { signal?: AbortSignal }) {
  return api.get<{ configured: boolean }>('/integrations/google/status', options);
}

export const GOOGLE_SERVICE_LABEL: Record<'search-console' | 'analytics', string> = {
  'search-console': 'Google Search Console',
  analytics: 'Google Analytics',
};
