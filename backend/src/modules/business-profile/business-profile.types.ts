/**
 * Types, status vocabularies and transition rules for G04 — confirmed intake,
 * the versioned business profile, project attachment and the access checklist.
 *
 * SQLite has no enums: `OnboardingRequest.status` is a `String` whose
 * permitted values are documented on the Prisma model and re-validated here
 * before any write, so no endpoint can accept an arbitrary status jump.
 *
 * @module business-profile.types
 */

// ─── Business profile ────────────────────────────────────────────────

/**
 * Where a profile row sits in its life. `draft` is not a lesser `confirmed`:
 * a draft is a proposal nobody has stood behind, and every read path in this
 * module reports which one it is holding.
 */
export type ProfileState = 'draft' | 'confirmed';

/** JSON contract for `BusinessProfile.icp`. */
export interface IcpShape {
  /** Who the business sells to, in the client's words. */
  segments: string[];
  /** Job titles/roles that buy or influence the purchase. */
  roles: string[];
  /** Problems the buyer arrives with. */
  painPoints: string[];
}

/** One entry of the `BusinessProfile.facts` JSON array. */
export interface FactShape {
  fact: string;
  /** Where the claim can be checked. Null when the client asserted it uncovered. */
  evidenceUrl: string | null;
}

/** One entry of the `BusinessProfile.competitors` JSON array. */
export interface CompetitorShape {
  name: string;
  domain: string | null;
}

/** One entry of the `BusinessProfile.approvers` JSON array. */
export interface ApproverShape {
  name: string;
  email: string | null;
  role: string | null;
}

/** JSON contract for `BusinessProfile.publishing`. */
export interface PublishingShape {
  cms: string | null;
  constraints: string | null;
  styleNotes: string | null;
}

// ─── Target markets (P04 — plan §10.1) ─────────────────────────────────

/**
 * Where measurement happens is not the same fact as where a company is
 * headquartered. §10.1: "A company headquartered in India and selling to the
 * US must be measured for the US when that is its confirmed target."
 *
 * `country` is required and is the unit every provider adapter can actually
 * target (§10.3 — Cloro sends country only; nothing here proves city-level
 * support). `region`/`city` narrow it for provider-support preview and
 * disclosure, never for silently substituting a different scope.
 *
 * A target's confirmation state is NOT stored per-row: it rides the same
 * draft/confirm versioning as every other `BusinessProfileData` field (see
 * `business-profile.service.ts` module doc, rule 1). A target inside a draft
 * row is a proposal; a target inside a confirmed row is a fact. This is the
 * "just another confirmable field group on the same profile" design chosen
 * over a parallel per-target approval workflow.
 */
export interface MarketTarget {
  /** ISO-3166 alpha-2, uppercase. Required — the one unit every adapter understands. */
  country: string;
  /** Optional state/province, free text as the client names it. */
  region: string | null;
  /** Optional city. Narrower than any provider adapter can currently prove it targets. */
  city: string | null;
  /** Optional BCP-47 language tag for this target, when it differs from the profile's general `languages`. */
  language: string | null;
  /** Lower is higher priority. Ties broken by array order. */
  priority: number;
  /** False = kept on file but excluded from measurement scope and cost estimates. */
  active: boolean;
  /** Optional — which services/products this target applies to. Empty = all of them. */
  productApplicability: string[];
}

/** The confirmed-or-proposed business facts, with every JSON column parsed. */
export interface BusinessProfileData {
  brandName: string | null;
  legalName: string | null;
  description: string | null;
  services: string[];
  icp: IcpShape;
  /** Legacy flat market list — kept for backward-compat readers. Superseded by `targets` for anything that needs real granularity/provider support (P04). */
  markets: string[];
  languages: string[];
  /** Structured confirmed/drafted target markets (P04, plan §10.1). */
  targets: MarketTarget[];
  facts: FactShape[];
  competitors: CompetitorShape[];
  goals: string[];
  approvers: ApproverShape[];
  publishing: PublishingShape;
}

/** A single version of a project's business profile. */
export interface BusinessProfileDto {
  id: string;
  projectId: string;
  version: number;
  state: ProfileState;
  /** Convenience for callers that only branch on this — identical to `state === 'draft'`. */
  isDraft: boolean;
  /** Null until a human confirms. A row with `confirmedAt === null` is a proposal. */
  confirmedBy: string | null;
  confirmedAt: string | null;
  data: BusinessProfileData;
  /** The newest CONFIRMED version known, or null when nothing has ever been confirmed. */
  confirmedVersion: ProfileVersionRef | null;
  /** True when this row is the newest version of any state. */
  isLatest: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Identity of one profile version, without its payload. */
export interface ProfileVersionRef {
  id: string;
  version: number;
  state: ProfileState;
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

/**
 * A scraped guess from `SiteContext`, served on its own surface and never
 * merged into {@link BusinessProfileData}. `provenance` is fixed to
 * `'extracted'` so a consumer cannot render one of these as a confirmed fact
 * even by accident — there is no shape here that carries `confirmedAt`.
 */
export interface SiteContextCandidateDto {
  id: string;
  projectId: string;
  provenance: 'extracted';
  /** Always false. Present so a careless spread into a profile response is still visibly wrong. */
  confirmed: false;
  domain: string;
  brand: string;
  category: string | null;
  vertical: string | null;
  description: string | null;
  geo: string | null;
  markets: string[];
  services: string[];
  icp: string[];
  valueProps: string[];
  painPoints: string[];
  outcomes: string[];
  competitors: CompetitorShape[];
  /** `deterministic` (no model) or `llm-synthesized` — the extraction's own claim about itself. */
  extraction: string;
  llmModel: string | null;
  pagesFetched: number;
  pageUrls: string[];
  costUsd: number;
  createdAt: string;
}

/**
 * The sentence every candidate response carries, so the boundary between a
 * scrape and a fact is stated by the API rather than assumed by the consumer.
 */
export const BUSINESS_PROFILE_PROVENANCE_NOTE =
  'These are extracted candidates from the project site. They are not confirmed facts: nothing here has been seen or agreed to by a human, and no value here is served as confirmed anywhere in the API. To use one, type it into the business profile draft and confirm that version.';

// ─── Business information (P02 — plan §9.1/§9.2) ──────────────────────

/**
 * Every field the "Business information" screens (staff and client) group
 * into sections. A dot-path into {@link BusinessProfileData} — the same string
 * is what `PUT .../business-profile` accepts on its matching top-level key
 * (nested ones are patched via their parent object, see the merge patch DTO)
 * and what {@link BusinessProfileRejectionRow}.fieldPath stores.
 */
export const BUSINESS_INFO_FIELDS = [
  'brandName',
  'legalName',
  'description',
  'services',
  'icp.segments',
  'icp.roles',
  'icp.painPoints',
  'markets',
  'languages',
  'competitors',
  'goals',
] as const;
export type BusinessInfoField = (typeof BUSINESS_INFO_FIELDS)[number];

/** Which of the four §9.1 sections a field is grouped under on the UI. */
export type BusinessInfoSectionKey = 'about' | 'customers' | 'locations' | 'brand';

/**
 * One field's suggested value from the most recent `SiteContext`, next to the
 * confirmed-or-drafted value it would replace. Deliberately carries only
 * client-safe provenance (a source page and a date) — no run id, no model
 * name, no cost. Staff and client screens read the identical shape; §4.6 only
 * changes which vocabulary a screen wraps it in, not which fields exist.
 */
export interface BusinessInfoSuggestion {
  field: BusinessInfoField;
  section: BusinessInfoSectionKey;
  label: string;
  /** The value on file today (draft or confirmed — whichever is current). Null/empty when there is none. */
  currentValue: string[] | string | null;
  suggestedValue: string[] | string | null;
  /** A page the suggestion can be checked against, when the crawl recorded one. */
  sourcePage: string | null;
  /** When the source SiteContext was built. */
  sourceDate: string;
}

/** A field with nothing confirmed/drafted AND nothing suggested. */
export interface BusinessInfoGap {
  field: BusinessInfoField;
  section: BusinessInfoSectionKey;
  label: string;
}

export interface BusinessInfoSection {
  key: BusinessInfoSectionKey;
  label: string;
  /** Fields in this section, by their current confirmed-or-drafted value. */
  confirmed: Array<{ field: BusinessInfoField; label: string; value: string[] | string | null }>;
  suggestions: BusinessInfoSuggestion[];
  gaps: BusinessInfoGap[];
}

/**
 * Identity of a confirmed version WITHOUT `confirmedBy` — a raw `User.id`.
 * `overview` is served identically to staff and client, so this (not
 * {@link ProfileVersionRef}) is what it carries: a client-safe fact ("version
 * 3, confirmed on the 3rd") with no internal actor id riding along.
 */
export interface BusinessInfoVersionRef {
  id: string;
  version: number;
  state: ProfileState;
  confirmedAt: string | null;
  createdAt: string;
}

export interface BusinessInfoOverview {
  projectId: string;
  /** Null when nothing has ever been drafted. */
  profileState: ProfileState | null;
  confirmedVersion: BusinessInfoVersionRef | null;
  sections: BusinessInfoSection[];
  /** How many suggestions were withheld because they exactly repeat a prior rejection — the resurfacing this exists to stop. */
  suppressedRejectedCount: number;
  hasSiteContext: boolean;
  sourceCheckedAt: string | null;
}

// ─── Explicit propagation ────────────────────────────────────────────

/**
 * The downstream artifacts an explicit rebuild can bring forward. Deliberately
 * short: this endpoint propagates only what the confirmed profile is the
 * direct source of. Everything else on the project is re-derived by its own
 * endpoint, which is what "changed facts propagate only on explicit rebuild"
 * means in practice (design_plan §5.3).
 */
export const REBUILD_TARGETS = ['project-competitors'] as const;
export type RebuildTarget = (typeof REBUILD_TARGETS)[number];

/** Distinct from `REBUILD_TARGETS`: things an operator might EXPECT to move
 *  and which deliberately do not, with the endpoint that owns them. */
export interface DownstreamOwner {
  artifact: string;
  endpoint: string;
}

export const DOWNSTREAM_NOT_TOUCHED: readonly DownstreamOwner[] = [
  { artifact: 'gap-analysis', endpoint: 'POST /api/projects/:projectId/gap-analysis/sync' },
  { artifact: 'strategy', endpoint: 'POST /api/projects/:projectId/strategy/build' },
  { artifact: 'findings', endpoint: 'POST /api/projects/:projectId/findings/generate' },
  { artifact: 'report', endpoint: 'POST /api/projects/:projectId/reports' },
];

// ─── Target markets — provider support preview (P04, plan §10.3) ──────

/** A provider's real ability to target a location, read from its adapter's actual request-building code — never assumed. */
export type ProviderTargetingMode = 'provider-targeted' | 'prompt-localized' | 'unsupported';

/** The finest location unit a provider call can genuinely claim to have observed. */
export type LocationGranularity = 'country' | 'region' | 'city' | 'none';

/** One provider's support preview for one requested target — §10.3's adapter-boundary contract. */
export interface ProviderTargetSupport {
  provider: string;
  /** Human label for display. */
  providerLabel: string;
  requestedCountry: string;
  requestedCity: string | null;
  /** What the provider call would actually be able to claim as observed. */
  effectiveGranularity: LocationGranularity;
  mode: ProviderTargetingMode;
  /** How the requested location maps to the provider's own request field, when it maps at all. */
  providerMapping: string | null;
  supported: boolean;
  /** Why, in one sentence — always present so "supported: false" is never silent. */
  detail: string;
}

/** The confirmed-or-drafted structured targets, the site-evidence suggestions still open, and the real per-provider support preview. */
export interface TargetLocationsOverview {
  projectId: string;
  profileState: ProfileState | null;
  confirmedVersion: BusinessInfoVersionRef | null;
  /** The targets on the current confirmed-or-drafted profile, in priority order. */
  targets: MarketTarget[];
  /** Countries `SiteContext.markets` (P03's ranked service-area evidence) names that are not yet an active confirmed/drafted target — offered, never auto-applied. */
  suggestedCountries: string[];
  providerSupport: ProviderTargetSupport[];
  hasSiteContext: boolean;
  sourceCheckedAt: string | null;
}

// ─── Onboarding requests and the access checklist ────────────────────

/** `OnboardingRequest.kind` — the asks the welcome checklist tracks. */
export const ONBOARDING_REQUEST_KINDS = [
  'gsc-access',
  'ga4-access',
  'confirm-profile',
  'cms-access',
  'brand-assets',
  'other',
] as const;
export type OnboardingRequestKind = (typeof ONBOARDING_REQUEST_KINDS)[number];

/** `OnboardingRequest.status`. */
export const ONBOARDING_REQUEST_STATUSES = ['open', 'in-progress', 'done', 'waived'] as const;
export type OnboardingRequestStatus = (typeof ONBOARDING_REQUEST_STATUSES)[number];

/** Statuses that mean the ask is still outstanding for the client. */
export const OPEN_REQUEST_STATUSES: readonly OnboardingRequestStatus[] = ['open', 'in-progress'];

/**
 * Permitted status moves. `done` and `waived` are both terminal-but-reopenable:
 * a request resolved by mistake has to be correctable, and reopening is the
 * only way to do that without deleting the record of it having been closed.
 */
export const ONBOARDING_REQUEST_TRANSITIONS: Record<OnboardingRequestStatus, readonly OnboardingRequestStatus[]> = {
  open: ['in-progress', 'done', 'waived'],
  'in-progress': ['open', 'done', 'waived'],
  done: ['open'],
  waived: ['open'],
};

/** A WorkItem id referenced by a request's `blockedWork`, resolved for display. */
export interface BlockedWorkLink {
  id: string;
  title: string | null;
  status: string | null;
  cycleId: string | null;
  /** True when the id no longer resolves — reported, never silently dropped. */
  missing: boolean;
}

export interface OnboardingRequestDto {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  detail: string | null;
  requestedOf: string | null;
  requestedBy: string | null;
  dueAt: string | null;
  status: OnboardingRequestStatus;
  /** The ids as stored. */
  blockedWork: string[];
  /** The same ids resolved to work items, so a client view can say WHAT is waiting. */
  blockedWorkLinks: BlockedWorkLink[];
  /** True while `status` is open or in-progress. */
  outstanding: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** True when `dueAt` is in the past and the request is still outstanding. */
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `ChecklistItem.state`. `not-requested` is NOT `done`, and `unavailable` is
 *  NOT a failure — design_plan §3.5's explicit unavailable state. */
export type ChecklistItemState = 'done' | 'outstanding' | 'not-requested' | 'unavailable';

/** Which side of the relationship owes the item. */
export type ChecklistItemOwner = 'client' | 'operator';

export interface ChecklistItem {
  key: string;
  label: string;
  owner: ChecklistItemOwner;
  state: ChecklistItemState;
  /** Human sentence describing the actual evidence behind `state`. */
  detail: string;
  /** Which record the state was read from, e.g. `business-profile`, `onboarding-request`, `client-member`, `cycle`. */
  source: string;
  /** The rule applied, when the state is derived rather than read directly. Null when the state IS the record's own status. */
  rule: string | null;
  requestId: string | null;
  dueAt: string | null;
}

export interface OnboardingChecklistDto {
  projectId: string;
  generatedAt: string;
  /** False when the project has no Client attached — the checklist is still
   *  readable, but there is nobody on the client side to own the items. */
  hasClient: boolean;
  items: ChecklistItem[];
  counts: {
    done: number;
    outstanding: number;
    notRequested: number;
    unavailable: number;
  };
  /**
   * Outstanding asks with the work they are holding up. This is the "why is
   * this waiting on me" view: each entry names the request and the work items
   * blocked behind it, resolved to titles and statuses.
   */
  blocking: Array<{
    requestId: string;
    title: string;
    kind: string;
    status: OnboardingRequestStatus;
    dueAt: string | null;
    overdue: boolean;
    requestedOf: string | null;
    blockedWorkLinks: BlockedWorkLink[];
  }>;
  /** Work items referenced by an outstanding request but no longer present. */
  missingBlockedWork: string[];
}

// ─── Attachment ──────────────────────────────────────────────────────

/**
 * Whether a project is actually owned by a client.
 *
 * `Project` carries BOTH a nullable `clientId` (a relation) and a legacy
 * `clientName` (a display string). They are different things and this shape
 * is the one place that says so: `established` is true only when `clientId` is
 * set, and `clientName` is reported as a label that establishes nothing.
 */
export interface ProjectOwnershipDto {
  /** The owning Client.id, or null. The only field that establishes ownership. */
  clientId: string | null;
  /** Legacy display label copied from a Project column. Never consulted as ownership. */
  clientName: string | null;
  /** True only when `clientId` is non-null. */
  established: boolean;
  /** The owning Client's current name, resolved from `clientId` — null when there is no client. */
  clientDisplayName: string | null;
  /** True when the row carries a `clientName` label but no `clientId`. */
  labelWithoutOwnership: boolean;
}

export interface ProjectAttachmentDto {
  project: {
    id: string;
    name: string;
    domain: string;
    status: string;
    onboardingStatus: string;
    onboardingStep: string | null;
  };
  ownership: ProjectOwnershipDto;
  /** True when `clientId` now points at the client named in the URL. */
  attached: boolean;
  /** The client the project was moved away from, when it was. */
  reassignedFrom: string | null;
  /** Non-blocking facts the operator should know, e.g. a legacy label being superseded. */
  warnings: string[];
}
