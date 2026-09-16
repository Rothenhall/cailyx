import { api } from '@/lib/api';

/**
 * Client-side business-profile adapter (design_plan G04) — CP04 "welcome
 * checklist" and CP03's "agreed goals / baseline readiness".
 *
 * Routes: `@ClientPortal() @Controller('portal/projects/:projectId')` in
 * `backend/src/modules/business-profile/business-profile.controller.ts` and
 * `@ClientPortal() @Controller('portal/projects/:projectId/capabilities')` in
 * the capabilities module. `clientId` comes from the JWT in every case, and
 * each handler still asserts the project belongs to that client.
 *
 * ## Draft versus confirmed is the distinction this module exists for
 *
 * A profile row is a **proposal** until a human confirms it (`confirmedAt` is
 * null), and an edit never rewrites a confirmed row — confirming writes a new
 * version, so the record of what was agreed to survives the next edit. Nothing
 * on the client surface may present a draft as agreed fact, and a client
 * correcting their own details produces a new draft that an operator confirms.
 *
 * `confirmedBy` is deliberately absent from {@link PortalBusinessProfile}: it
 * is a raw `User.id`. `confirmedAt` is the fact a screen shows.
 *
 * @module services/portal-profile
 */

export type PortalProfileState = 'draft' | 'confirmed';

export interface PortalProfileFact {
  fact: string;
  evidenceUrl?: string;
}

export interface PortalProfileCompetitor {
  name: string;
  domain?: string;
}

export interface PortalProfileData {
  brandName: string | null;
  legalName: string | null;
  description: string | null;
  services: string[];
  icp: {
    segments?: string[];
    roles?: string[];
    painPoints?: string[];
  };
  markets: string[];
  languages: string[];
  facts: PortalProfileFact[];
  competitors: PortalProfileCompetitor[];
  /** The client's own commercial goals, in their words — CP03's "agreed goals". */
  goals: string[];
  approvers: Array<{ name: string; email?: string; role?: string }>;
  publishing: { cms?: string; constraints?: string; styleNotes?: string };
}

export interface PortalProfileVersionRef {
  id: string;
  version: number;
  state: PortalProfileState;
  confirmedAt: string | null;
  createdAt: string;
}

export interface PortalBusinessProfile {
  id: string;
  projectId: string;
  version: number;
  state: PortalProfileState;
  /** Identical to `state === 'draft'`; present so a screen can branch on one field. */
  isDraft: boolean;
  /** Null until a human confirms. */
  confirmedAt: string | null;
  data: PortalProfileData;
  /** The newest CONFIRMED version, or null when nothing has ever been confirmed. */
  confirmedVersion: PortalProfileVersionRef | null;
  isLatest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PortalBusinessProfileResponse {
  projectId: string;
  /** Null when no profile has been drafted at all. */
  profile: PortalBusinessProfile | null;
  confirmedVersion: PortalProfileVersionRef | null;
  versionCount: number;
  /** Why there is no profile — a sentence, not an empty screen. */
  unavailableReason: string | null;
}

/**
 * Reads the latest profile of any state.
 *
 * `state: 'confirmed'` is the variant a caller uses when it must not cite a
 * guess; it 404s when nothing has ever been confirmed, which is a different
 * fact from "the values are empty".
 */
export async function getPortalBusinessProfile(
  projectId: string,
  opts: { version?: number; state?: 'latest' | 'confirmed' } = {},
  options?: { signal?: AbortSignal },
) {
  return api.get<PortalBusinessProfileResponse>(
    `/portal/projects/${encodeURIComponent(projectId)}/business-profile`,
    {
      ...options,
      query: { version: opts.version, state: opts.state === 'latest' ? undefined : opts.state },
    },
  );
}

/**
 * A **merge** onto the current draft — omitted fields are left as they are.
 *
 * A confirmed version is never rewritten by this call: if the newest row is
 * confirmed, the server forks a new unconfirmed version from it. That is why a
 * client "correction" always lands as a draft awaiting confirmation.
 */
export interface PortalProfilePatch {
  brandName?: string;
  legalName?: string;
  description?: string;
  services?: string[];
  markets?: string[];
  goals?: string[];
  /** Recorded in the audit trail; never stored on the profile row. */
  note?: string;
}

export async function savePortalBusinessProfileDraft(
  projectId: string,
  patch: PortalProfilePatch,
) {
  return api.put<{ profile: PortalBusinessProfile; warnings: string[] }>(
    `/portal/projects/${encodeURIComponent(projectId)}/business-profile`,
    patch,
  );
}

/**
 * Confirms the profile — "yes, these are our facts".
 *
 * Writes a NEW version carrying the confirming seat and time rather than
 * stamping the draft, so what the client was shown when they confirmed remains
 * on file. An empty draft is refused with 409 (there would be nothing for the
 * confirmation to be of).
 */
export async function confirmPortalBusinessProfile(
  projectId: string,
  input: { version?: number; note?: string } = {},
) {
  return api.post<{
    profile: PortalBusinessProfile;
    confirmedFrom: PortalProfileVersionRef | null;
    warnings: string[];
  }>(`/portal/projects/${encodeURIComponent(projectId)}/business-profile/confirm`, input);
}

// ── Welcome checklist ───────────────────────────────────────────────────

/** `not-requested` is NOT `done`, and `unavailable` is NOT a failure. */
export type PortalChecklistItemState = 'done' | 'outstanding' | 'not-requested' | 'unavailable';

export interface PortalChecklistItem {
  key: string;
  label: string;
  /** Which side of the relationship owes the item. */
  owner: 'client' | 'operator';
  state: PortalChecklistItemState;
  /** A human sentence describing the evidence behind `state`. */
  detail: string;
  /** Which record the state was read from, e.g. `business-profile`. */
  source: string;
  /** The rule applied, when the state is derived rather than read. */
  rule: string | null;
  requestId: string | null;
  dueAt: string | null;
}

export interface PortalBlockedWorkLink {
  id: string;
  title: string | null;
  status: string | null;
  cycleId: string | null;
  /** True when the id no longer resolves — reported, never silently dropped. */
  missing: boolean;
}

export interface PortalChecklistBlocking {
  requestId: string;
  title: string;
  kind: string;
  status: string;
  dueAt: string | null;
  overdue: boolean;
  /** Who the ask is directed at — free text or a seat name. */
  requestedOf: string | null;
  blockedWorkLinks: PortalBlockedWorkLink[];
}

export interface PortalChecklist {
  projectId: string;
  generatedAt: string;
  /** False when no Client is attached — nobody on the client side owns the items. */
  hasClient: boolean;
  items: PortalChecklistItem[];
  counts: {
    done: number;
    outstanding: number;
    notRequested: number;
    unavailable: number;
  };
  /** Outstanding asks with the work they are holding up. */
  blocking: PortalChecklistBlocking[];
  missingBlockedWork: string[];
}

export async function getPortalChecklist(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<PortalChecklist>(
    `/portal/projects/${encodeURIComponent(projectId)}/onboarding/checklist`,
    options,
  );
}

/**
 * The client's own action on an access request directed at them.
 *
 * Narrower than the operator's on purpose: a client can say "I've started it",
 * "I've done it", or reopen it — and nothing else. Waiving an ask is the
 * operator deciding not to need it.
 */
export async function updatePortalOnboardingRequest(
  projectId: string,
  requestId: string,
  input: { status: 'open' | 'in-progress' | 'done'; note?: string },
) {
  return api.patch<unknown>(
    `/portal/projects/${encodeURIComponent(projectId)}/onboarding/requests/${encodeURIComponent(requestId)}`,
    input,
  );
}

// ── Baseline readiness ──────────────────────────────────────────────────

export interface PortalCapability {
  /** A client-meaningful slug, never an internal key. */
  capability: string;
  label: string;
  description: string;
  available: boolean;
  state: 'available' | 'action-required' | 'not-set-up' | 'unavailable';
  /** What the client can do, when they can do anything. */
  clientAction: string | null;
  produces: string[];
  /** Null means not measured yet. */
  lastMeasuredAt: string | null;
  dataSource: 'live' | 'simulated-test' | 'unknown';
  /** Present only for `simulated-test`, so fixtures are never read as measurements. */
  dataSourceDisclosure: string | null;
}

export interface PortalCapabilities {
  projectId: string;
  audience: 'client';
  capabilities: PortalCapability[];
  summary: { total: number; available: number; actionRequired: number };
  note: string;
}

export async function getPortalCapabilities(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<PortalCapabilities>(
    `/portal/projects/${encodeURIComponent(projectId)}/capabilities`,
    options,
  );
}
