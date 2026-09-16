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

/** The confirmed-or-proposed business facts, with every JSON column parsed. */
export interface BusinessProfileData {
  brandName: string | null;
  legalName: string | null;
  description: string | null;
  services: string[];
  icp: IcpShape;
  markets: string[];
  languages: string[];
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
