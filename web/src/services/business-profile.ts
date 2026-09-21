import { api } from '@/lib/api';

/**
 * Staff-side business-profile adapter (design_plan G04 + P02 §9.1/§9.2).
 *
 * Routes: `@Controller('projects/:projectId/business-profile')` in
 * `backend/src/modules/business-profile/business-profile.controller.ts`.
 *
 * This is the operator counterpart of `services/portal-profile.ts` — the
 * `overview`/`reject` shapes are byte-for-byte identical between the two
 * audiences (the service that builds them is shared), so the types are kept
 * in step by hand rather than duplicated with drift. The staff screen may use
 * more precise vocabulary around this same data; see plan §4.3.
 */

export type BusinessProfileState = 'draft' | 'confirmed';

export interface BusinessProfileFact {
  fact: string;
  evidenceUrl: string | null;
}

export interface BusinessProfileCompetitor {
  name: string;
  domain: string | null;
}

export interface BusinessProfileData {
  brandName: string | null;
  legalName: string | null;
  description: string | null;
  services: string[];
  icp: { segments: string[]; roles: string[]; painPoints: string[] };
  markets: string[];
  languages: string[];
  facts: BusinessProfileFact[];
  competitors: BusinessProfileCompetitor[];
  goals: string[];
  approvers: Array<{ name: string; email: string | null; role: string | null }>;
  publishing: { cms: string | null; constraints: string | null; styleNotes: string | null };
}

export interface ProfileVersionRef {
  id: string;
  version: number;
  state: BusinessProfileState;
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface BusinessProfileDto {
  id: string;
  projectId: string;
  version: number;
  state: BusinessProfileState;
  isDraft: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  data: BusinessProfileData;
  confirmedVersion: ProfileVersionRef | null;
  isLatest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessProfileResponse {
  projectId: string;
  profile: BusinessProfileDto | null;
  confirmedVersion: ProfileVersionRef | null;
  versionCount: number;
  unavailableReason: string | null;
}

export async function getBusinessProfile(
  projectId: string,
  opts: { version?: number; state?: 'latest' | 'confirmed' } = {},
  options?: { signal?: AbortSignal },
) {
  return api.get<BusinessProfileResponse>(`/projects/${encodeURIComponent(projectId)}/business-profile`, {
    ...options,
    query: { version: opts.version, state: opts.state === 'latest' ? undefined : opts.state },
  });
}

export interface BusinessProfilePatch {
  brandName?: string;
  legalName?: string;
  description?: string;
  category?: string;
  services?: string[];
  icp?: { segments?: string[]; roles?: string[]; painPoints?: string[] };
  markets?: string[];
  languages?: string[];
  /** `domain` omitted (not null) means "no domain" — matches the server's `CompetitorDto`. */
  competitors?: Array<{ name: string; domain?: string }>;
  goals?: string[];
  note?: string;
}

export async function saveBusinessProfileDraft(projectId: string, patch: BusinessProfilePatch) {
  return api.put<{ profile: BusinessProfileDto; warnings: string[] }>(
    `/projects/${encodeURIComponent(projectId)}/business-profile`,
    patch,
  );
}

export async function confirmBusinessProfile(projectId: string, input: { version?: number; note?: string } = {}) {
  return api.post<{ profile: BusinessProfileDto; confirmedFrom: ProfileVersionRef; warnings: string[] }>(
    `/projects/${encodeURIComponent(projectId)}/business-profile/confirm`,
    input,
  );
}

// ── Business information overview (Confirmed / Suggested / Needs information) ──

export type BusinessInfoField =
  | 'brandName'
  | 'legalName'
  | 'description'
  | 'category'
  | 'services'
  | 'icp.segments'
  | 'icp.roles'
  | 'icp.painPoints'
  | 'markets'
  | 'languages'
  | 'competitors'
  | 'goals';

export type BusinessInfoSectionKey = 'about' | 'customers' | 'locations' | 'brand';

export interface BusinessInfoConfirmedField {
  field: BusinessInfoField;
  label: string;
  value: string[] | string | null;
}

export interface BusinessInfoSuggestion {
  field: BusinessInfoField;
  section: BusinessInfoSectionKey;
  label: string;
  currentValue: string[] | string | null;
  suggestedValue: string[] | string | null;
  sourcePage: string | null;
  sourceDate: string;
}

export interface BusinessInfoGap {
  field: BusinessInfoField;
  section: BusinessInfoSectionKey;
  label: string;
}

export interface BusinessInfoSection {
  key: BusinessInfoSectionKey;
  label: string;
  confirmed: BusinessInfoConfirmedField[];
  suggestions: BusinessInfoSuggestion[];
  gaps: BusinessInfoGap[];
}

/** No `confirmedBy` — `overview` is served identically to staff and the
 *  client portal, so it never carries a raw actor id. */
export interface BusinessInfoVersionRef {
  id: string;
  version: number;
  state: BusinessProfileState;
  confirmedAt: string | null;
  createdAt: string;
}

export interface BusinessInfoOverview {
  projectId: string;
  profileState: BusinessProfileState | null;
  confirmedVersion: BusinessInfoVersionRef | null;
  sections: BusinessInfoSection[];
  suppressedRejectedCount: number;
  hasSiteContext: boolean;
  sourceCheckedAt: string | null;
}

export async function getBusinessInfoOverview(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<BusinessInfoOverview>(
    `/projects/${encodeURIComponent(projectId)}/business-profile/overview`,
    options,
  );
}

/**
 * "Keep current" on one field's suggestion. The value declined is read from
 * the current site context server-side — this call only names WHICH field.
 */
export async function rejectBusinessInfoSuggestion(projectId: string, field: BusinessInfoField) {
  return api.post<{ field: string; rejected: boolean; detail: string }>(
    `/projects/${encodeURIComponent(projectId)}/business-profile/candidates/reject`,
    { field },
  );
}

// ── Target locations (P04 — structured target markets, plan §10) ──────────

/** One structured target market. `country` is the only unit any provider adapter read for this phase can genuinely target. */
export interface MarketTarget {
  country: string;
  region: string | null;
  city: string | null;
  language: string | null;
  priority: number;
  active: boolean;
  productApplicability: string[];
}

export type ProviderTargetingMode = 'provider-targeted' | 'prompt-localized' | 'unsupported';
export type LocationGranularity = 'country' | 'region' | 'city' | 'none';

export interface ProviderTargetSupport {
  provider: string;
  providerLabel: string;
  requestedCountry: string;
  requestedCity: string | null;
  effectiveGranularity: LocationGranularity;
  mode: ProviderTargetingMode;
  providerMapping: string | null;
  supported: boolean;
  detail: string;
}

export interface TargetLocationsOverview {
  projectId: string;
  profileState: BusinessProfileState | null;
  confirmedVersion: BusinessInfoVersionRef | null;
  targets: MarketTarget[];
  suggestedCountries: string[];
  providerSupport: ProviderTargetSupport[];
  hasSiteContext: boolean;
  sourceCheckedAt: string | null;
}

export async function getTargetLocations(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<TargetLocationsOverview>(
    `/projects/${encodeURIComponent(projectId)}/business-profile/target-locations`,
    options,
  );
}

/** Replaces the whole targets array on write — same merge semantics as every other field on `SaveBusinessProfileDto`. */
export async function saveTargetLocations(projectId: string, targets: MarketTarget[]) {
  return api.put<{ profile: BusinessProfileDto; warnings: string[] }>(
    `/projects/${encodeURIComponent(projectId)}/business-profile`,
    { targets },
  );
}

/** Human label for a field, used as a last-resort fallback if a screen ever
 *  needs one without the server-supplied `label`. */
export const BUSINESS_INFO_FIELD_FALLBACK_LABEL: Record<BusinessInfoField, string> = {
  brandName: 'Business name',
  legalName: 'Legal name',
  description: 'What you do',
  category: 'Business category / type',
  services: 'Products / services',
  'icp.segments': 'Customer types',
  'icp.roles': 'Buyer roles',
  'icp.painPoints': 'Problems customers arrive with',
  markets: 'Target locations',
  languages: 'Languages',
  competitors: 'Named competitors',
  goals: 'Commercial goals',
};
