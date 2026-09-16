import { api, ApiError } from '@/lib/api';
import type { OperatorRole, SafeUser } from './types';

/**
 * Administration adapters (G12/G15/G18/G20) — design_plan.md screens OP15–OP21.
 *
 * §4's administration family states the contract for all seven screens:
 * *"Settings sections by permission, explanation above high-impact actions,
 * explicit save/test; no client-facing secrets/config hints; separate saved
 * configuration from observed runtime health."*
 *
 * That last clause is the reason this file's most important types carry **four
 * separate facts** rather than a boolean. Where a backend module already made
 * that separation structurally — `CapabilityView`'s
 * configured/verified/authorized/resourceMapped, `UnitTotal`'s per-unit
 * ceilings, `ActivityEventDto`'s append-only shape — the type here repeats it
 * rather than flattening it, so a screen author cannot collapse it by accident.
 *
 * Every route below is `@Roles('admin')` or `@Roles('admin','delivery-lead')`
 * on the backend. Nothing here is a client-facing surface, and none of these
 * adapters should be imported into `(client)/`.
 */

// ── OP15 · Service connections ──────────────────────────────────────────

/**
 * Machine-readable "why not ready", mirroring
 * `backend/src/modules/capabilities/capabilities.types.ts`.
 */
export type BlockedBy =
  | 'credential-missing'
  | 'master-switch-off'
  | 'session-missing'
  | 'session-file-missing'
  | 'prerequisite'
  | 'not-authorized'
  | 'resource-unmapped'
  | 'never-verified'
  | 'last-call-failed'
  | 'mock-only';

export type CapabilityState =
  | 'ready'
  | 'unverified'
  | 'unconfigured'
  | 'blocked'
  | 'mock'
  | 'degraded'
  | 'unauthorized'
  | 'unmapped';

export interface CapabilitySchedulerState {
  taskKind: string;
  enabled: boolean;
  frequency: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  pausedAt: string | null;
}

/**
 * One capability, with the four readiness facts **kept separate**.
 *
 * §3.5's "Credentials configured but runtime unverified" is exactly the case
 * this shape exists for: `configured: true, verified: false` must render as
 * "Configured; last successful run unknown", never as ready. The screen may
 * not derive readiness from `configured` alone — `allowedActions` is empty
 * unless the backend already decided `state === 'ready'`.
 */
export interface CapabilityView {
  key: string;
  label: string;
  category: string;

  /** Server config is present. Says nothing about whether it works. */
  configured: boolean;
  /** A real call has succeeded and been recorded. Never derived from config. */
  verified: boolean;
  /** This caller may use it. */
  authorized: boolean;
  /** This project is wired to the resource it needs. Null on the global route. */
  resourceMapped: boolean | null;

  state: CapabilityState;
  /** Why it is in this state, in one sentence. Never empty. */
  stateDetail: string;
  /** What an operator should know about the configuration, whatever the state. */
  operatorGuidance: string;
  blockedBy: BlockedBy | null;
  /**
   * Actions the server will currently accept. **Empty unless the state is
   * `ready`** — this is §3.5's "no enabled button merely because an env key
   * exists" expressed as data, so a screen renders the button from this list
   * and cannot invent one.
   */
  allowedActions: string[];
  retryable: boolean;

  supportedProviders: string[];
  availableOutputs: string[];
  prerequisites: string[];
  /** Prerequisite keys that are not ready, in the same order. */
  unmetPrerequisites: string[];
  limits: Record<string, unknown>;

  /** Fixture mode. Visible wherever it applies, never only in a detail view. */
  mockMode: boolean;
  /** The sentence to show when `mockMode` is true; null otherwise. */
  mockDisclosure: string | null;

  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  /** Operator-only: the raw provider error, as recorded. */
  lastError: string | null;
  checkedAt: string;

  /** Env var names. Operator surface only — never rendered on a client page. */
  envVars: string[];
  /** Operator-only config detail (session path, model id, actor map). */
  configDetail: string | null;

  /** Present on the project route only. */
  scheduler?: CapabilitySchedulerState[];
}

export interface CapabilitySummary {
  total: number;
  ready: number;
  byState: Record<string, number>;
  /** Every capability currently running against fixtures. Always disclosed. */
  mockModeKeys: string[];
}

export interface CapabilityRoster {
  capabilities: CapabilityView[];
  summary: CapabilitySummary;
  audience: 'operator';
}

/**
 * The whole readiness roster.
 *
 * Readable by **any operator role**, not just admin: knowing what can actually
 * run is a precondition for doing the work, not an administrative privilege.
 * The nav lists OP15 for admins and delivery leads, but the endpoint's guard is
 * broader than the nav's filter, so a copied link works for other roles too.
 */
export async function listCapabilities(options?: { signal?: AbortSignal }) {
  return api.get<CapabilityRoster>('/capabilities', options);
}

/** The same roster narrowed to one project, adding mapped resources + schedulers. */
export async function listProjectCapabilities(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<CapabilityRoster & {
    projectId: string;
    project: { id: string; name: string; domain: string } | null;
  }>(`/projects/${projectId}/capabilities`, options);
}

// ── OP16 · People ───────────────────────────────────────────────────────

export async function listOperators(options?: { signal?: AbortSignal }) {
  return api.get<{ users: SafeUser[] }>('/users', options);
}

export async function listOperatorRoles(options?: { signal?: AbortSignal }) {
  return api.get<{ roles: string[] }>('/users/roles', options);
}

export async function createOperator(input: {
  email: string;
  name: string;
  password: string;
  role: OperatorRole;
}) {
  return api.post<SafeUser>('/users', input);
}

export async function updateOperator(id: string, input: { name?: string; role?: OperatorRole }) {
  return api.patch<SafeUser>(`/users/${id}`, input);
}

/**
 * Resets an operator's password. The response reports how many sessions were
 * revoked — a reset that left live sessions behind would be a partial action,
 * so the screen shows the number rather than a bare "done".
 */
export async function resetOperatorPassword(id: string, password: string) {
  return api.post<{ id: string; sessionsRevoked: number }>(`/users/${id}/password`, { password });
}

export async function deleteOperator(id: string) {
  return api.delete<{ removed: string }>(`/users/${id}`);
}

// ── OP19 · Activity audit ───────────────────────────────────────────────

export type ActorType = 'user' | 'system' | 'scheduler' | 'webhook';
export type ActivityResult = 'success' | 'failure';
export type ActivityOrigin = 'api' | 'ui' | 'scheduler' | 'webhook';

export const ACTIVITY_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'released',
  'approved',
  'rejected',
  'published',
  'sent',
  'started',
  'cancelled',
  'granted',
  'revoked',
  'logged-in',
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/**
 * One audit event, as the API returns it.
 *
 * This log is **append-only and there is no write route** (by design — see the
 * controller's own note: an HTTP endpoint taking actor/result from a body
 * would let a caller forge the record it is evidence of). The screen therefore
 * offers no edit and no delete control, and does not filter failures out of
 * the list: a failed action is exactly what an audit log is for.
 */
export interface ActivityEvent {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: ActivityAction;
  resourceType: string;
  resourceId: string | null;
  resourceVersion: string | null;
  clientId: string | null;
  projectId: string | null;
  summary: string | null;
  /** Parsed JSON, already redacted before it was written. */
  changes: Record<string, unknown>;
  result: ActivityResult;
  requestId: string | null;
  jobRunId: string | null;
  origin: ActivityOrigin;
  clientVisible: boolean;
  createdAt: string;
}

export interface ActivityQuery {
  resourceType?: string;
  resourceId?: string;
  action?: ActivityAction;
  clientId?: string;
  projectId?: string;
  actorId?: string;
  limit?: number;
  cursor?: string;
}

export async function listActivity(query: ActivityQuery, options?: { signal?: AbortSignal }) {
  return api.get<{ events: ActivityEvent[]; nextCursor: string | null }>('/activity', {
    ...options,
    query: query as Record<string, string | number | undefined>,
  });
}

/**
 * The same filters, unpaginated up to the service's 5000-event cap, so an
 * export is assembled from one complete set rather than pages that shift
 * underneath it.
 */
export async function exportActivity(
  query: Omit<ActivityQuery, 'limit' | 'cursor' | 'actorId' | 'resourceId'>,
  options?: { signal?: AbortSignal },
) {
  return api.get<{ events: ActivityEvent[] }>('/activity/export', {
    ...options,
    query: query as Record<string, string | undefined>,
  });
}

// ── OP21 · Organization settings ────────────────────────────────────────

/**
 * The settings in force.
 *
 * `version: null` with `persisted: false` is a real state, not a missing row:
 * the values are then the schema's declared defaults. A released document that
 * pinned `null` was published under the application defaults, which is a
 * different fact from "published under version 1", and the screen says so.
 */
export interface OrganizationSettings {
  version: number | null;
  persisted: boolean;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  supportName: string | null;
  timezone: string;
  defaultTier: string;
  reviewSlaHours: number;
  /** Whether operators may mint anyone-with-the-link report shares. */
  allowPublicShare: boolean;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function getOrganizationSettings(
  query?: { version?: number },
  options?: { signal?: AbortSignal },
) {
  return api.get<OrganizationSettings>('/organization/settings', { ...options, query });
}

export async function listSettingsVersions(options?: { signal?: AbortSignal }) {
  return api.get<{
    versions: OrganizationSettings[];
    versionInForce: number | null;
  }>('/organization/settings/versions', options);
}

/**
 * Writes a **new version**. Settings are append-only: the row this reads is
 * never modified, which is what lets an already-released report keep reading
 * the values it was published under. Omitted fields carry forward; `null`
 * clears a nullable field.
 */
export async function writeOrganizationSettings(
  patch: Partial<{
    displayName: string;
    logoUrl: string | null;
    primaryColor: string | null;
    supportEmail: string | null;
    supportName: string | null;
    timezone: string;
    defaultTier: string;
    reviewSlaHours: number;
    allowPublicShare: boolean;
  }>,
) {
  return api.put<OrganizationSettings>('/organization/settings', patch);
}

export interface BrandingSnapshot {
  settingsVersion: number | null;
  branding: {
    orgName: string;
    logoUrl?: string;
    palette?: { primary?: string };
  };
  cssVariables: Record<string, string>;
}

export async function getBranding(options?: { signal?: AbortSignal }) {
  return api.get<BrandingSnapshot>('/organization/branding', options);
}

export async function getPublicSharePolicy(options?: { signal?: AbortSignal }) {
  return api.get<{ allowPublicShare: boolean; settingsVersion: number | null; persisted: boolean }>(
    '/organization/policy/public-share',
    options,
  );
}

// ── OP17 · Rubrics ──────────────────────────────────────────────────────

/**
 * The five weighted dimensions, with the backend's own defaults.
 *
 * ⚠️ The JSON column keys are camelCase; `ScoreRun.subScores[].dimension` uses
 * the **human labels** instead. The two vocabularies are bridged here, once,
 * rather than at each call site.
 */
export const RUBRIC_DIMENSIONS = [
  { key: 'machineAccess', label: 'Machine access' },
  { key: 'entityClarity', label: 'Entity clarity' },
  { key: 'shortlistPresence', label: 'Shortlist presence' },
  { key: 'extractability', label: 'On-page extractability' },
  { key: 'authority', label: 'Authority signal' },
] as const;

export type RubricDimensionKey = (typeof RUBRIC_DIMENSIONS)[number]['key'];
export type RubricWeights = Record<RubricDimensionKey, number>;

export const DEFAULT_RUBRIC_WEIGHTS: RubricWeights = {
  machineAccess: 25,
  entityClarity: 25,
  shortlistPresence: 20,
  extractability: 20,
  authority: 10,
};

/** §8: the weights of one rubric version must sum to exactly this. */
export const RUBRIC_WEIGHT_TOTAL = 100;

export const SCORE_BANDS = ['invisible', 'faint', 'present', 'recommended'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/** Band boundaries are an ascending list of `max` values; the last one catches the rest. */
export interface RubricBand {
  max: number;
  band: string;
}

export const DEFAULT_RUBRIC_BANDS: RubricBand[] = [
  { max: 40, band: 'invisible' },
  { max: 60, band: 'faint' },
  { max: 80, band: 'present' },
  { max: 100, band: 'recommended' },
];

export interface ScoreRubric {
  id: string;
  version: number;
  /** Parsed by this adapter — the column is a JSON string on the wire. */
  weights: RubricWeights;
  /** Parsed by this adapter. */
  bands: RubricBand[];
  active: boolean;
  note: string | null;
  createdAt: string;
}

/**
 * `weights` and `bands` are `String` JSON columns on `ScoreRubric`, and unlike
 * every other scoring read the service does **not** parse them for the rubric
 * list. Parsing here — in the adapter, once — is what keeps a screen from
 * having to remember which of two shapes it received.
 *
 * A rubric whose weights cannot be read is not renderable: showing it with no
 * dimensions would look like a rubric that scores nothing. The parse failure is
 * raised as an `ApiError` so the screen shows an error rather than a lie.
 */
function parseRubric(row: {
  id: string;
  version: number;
  weights: unknown;
  bands: unknown;
  active: boolean;
  note: string | null;
  createdAt: string;
}): ScoreRubric {
  const weights = parseJson<Partial<RubricWeights>>(row.weights, 'weights', row.version);
  const bands = parseJson<RubricBand[]>(row.bands, 'bands', row.version);
  return {
    id: row.id,
    version: row.version,
    weights: { ...DEFAULT_RUBRIC_WEIGHTS, ...weights },
    bands: Array.isArray(bands) ? bands : DEFAULT_RUBRIC_BANDS,
    active: row.active,
    note: row.note,
    createdAt: row.createdAt,
  };
}

function parseJson<T>(value: unknown, field: string, version: number): T {
  if (value === null || value === undefined) {
    throw new ApiError({
      kind: 'unknown',
      status: 0,
      message: `Rubric version ${version} returned no "${field}", so it cannot be read.`,
      body: value,
    });
  }
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ApiError({
      kind: 'unknown',
      status: 0,
      message: `Rubric version ${version}'s "${field}" is not readable JSON.`,
      body: value,
    });
  }
}

/** Rubric versions, newest first. A **bare array**, not an envelope. */
export async function listRubrics(options?: { signal?: AbortSignal }) {
  const rows = await api.get<Parameters<typeof parseRubric>[0][]>('/rubrics', options);
  return rows.map(parseRubric);
}

/**
 * Creates a rubric version.
 *
 * `weights` is a **partial** on the wire: omitted dimensions fall back to the
 * documented defaults, and the merged result must sum to 100 or the request is
 * a 400. This adapter always sends the full set, so the number the operator
 * sees on screen is the number the server validates.
 */
export async function createRubric(input: {
  weights: RubricWeights;
  bands?: RubricBand[];
  activate?: boolean;
  note?: string;
}) {
  const row = await api.post<Parameters<typeof parseRubric>[0]>('/rubrics', {
    weights: input.weights,
    bands: input.bands,
    activate: input.activate,
    note: input.note,
  });
  return parseRubric(row);
}

/** True when the weights are usable under §8's rule. */
export function weightsSum(weights: Partial<RubricWeights>): number {
  return Object.values(weights).reduce<number>(
    (total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
    0,
  );
}

// ── OP18 · Budgets, estimates, spend and reservations ───────────────────
//
// ⚠️ There is **no cross-project budget route**. Every budget read and write is
// nested under `/projects/:projectId` and calls `assertProjectAccess`, so an
// organization-wide budget total is not merely unbuilt — it is structurally
// absent from this API. The screen therefore works one project at a time, and
// says so, rather than fanning out one request per project (which §10.3 also
// forbids: the global limit is 100 requests/minute/IP).

export const TASK_KINDS = [
  'technical-audit',
  'seo-audit',
  'aeo-audit',
  'presence',
  'serp',
  'mentions',
  'backlinks',
  'gap',
  'score',
  'report',
  'content-generation',
  'onboarding',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const SPEND_UNITS = ['usd', 'credits'] as const;
export type SpendUnit = (typeof SPEND_UNITS)[number];

export const BUDGET_SCOPE_TYPES = ['client', 'project', 'operation'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_PERIODS = ['day', 'week', 'month', 'cycle', 'total'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_ENFORCEMENTS = ['hard', 'soft'] as const;
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number];

export const RESERVATION_STATUSES = ['held', 'settled', 'released', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Usage against one ceiling, **for one unit**.
 *
 * Credits and dollars are different quantities; nothing here adds them and no
 * screen may. `limit: null` means the policy sets no ceiling in this unit —
 * which is not a limit of zero, and not the same as "within budget".
 */
export interface UnitTotal {
  unit: SpendUnit;
  limit: number | null;
  /** Sum of `held` reservations that have not expired. A hold is not spend. */
  reservedHeld: number;
  /** Sum of settled actuals plus directly-recorded spend. */
  settled: number;
  remaining: number | null;
  overLimit: boolean | null;
}

export interface PolicyWindow {
  period: BudgetPeriod;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  resolved: 'calendar' | 'project-cycle' | 'all-time' | 'unresolved';
  unresolvedReason?: string;
}

export interface PolicyEvaluation {
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  taskKind: string | null;
  enforcement: BudgetEnforcement;
  window: PolicyWindow;
  totals: UnitTotal[];
  exceeded: boolean;
  perRunCapUsd: number | null;
}

export interface UnresolvedPolicy {
  policyId: string;
  scopeType: string;
  taskKind: string | null;
  enforcement: BudgetEnforcement;
  period: string;
  reason: string;
}

export interface BindingCeiling {
  unit: SpendUnit;
  policyId: string;
  limit: number;
  remaining: number;
}

export interface BudgetView {
  projectId: string;
  timezone: string;
  evaluatedForTaskKind: string | null;
  /** Set when no taskKind was given: operation ceilings were not evaluated. */
  operationCeilingsExcluded: string | null;
  activeCycle: { id: string; name: string; startsOn: string; endsOn: string } | null;
  policies: PolicyEvaluation[];
  unresolvedPolicies: UnresolvedPolicy[];
  bindingCeilings: BindingCeiling[];
  /** Units no policy caps. Reported so "unbounded" never reads as "within budget". */
  unboundedUnits: SpendUnit[];
  notes: string[];
}

export async function getBudgetView(
  projectId: string,
  taskKind?: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<BudgetView>(`/projects/${projectId}/budget`, {
    ...options,
    query: taskKind ? { taskKind } : undefined,
  });
}

export async function putBudgetPolicy(
  projectId: string,
  input: {
    taskKind?: TaskKind;
    limitUsd?: number | null;
    limitCredits?: number | null;
    period?: BudgetPeriod;
    enforcement?: BudgetEnforcement;
    perRunCapUsd?: number | null;
  },
) {
  return api.put<{
    policyId: string;
    scopeType: BudgetScopeType;
    scopeId: string;
    taskKind: string | null;
    limitUsd: number | null;
    limitCredits: number | null;
    period: string;
    enforcement: string;
    perRunCapUsd: number | null;
    replaced: boolean;
    budget: BudgetView;
  }>(`/projects/${projectId}/budget`, input);
}

export interface CostEstimateRange {
  unit: SpendUnit;
  low: number;
  high: number;
  rangeKind: 'point' | 'range';
  basis: 'cloro-credit-tariff' | 'provider-published-rate' | 'measured-history';
  basisDetail: string;
  caller: string;
}

export interface CostEstimate {
  available: boolean;
  provider: string | null;
  assumedDefaults?: boolean;
  /** Only when `available` is false. Never a zero standing in for "no estimator". */
  reason?: string;
  /** **Separate rows per unit.** There is no combined total, by design. */
  ranges: CostEstimateRange[];
  /**
   * A credits→USD conversion, reported as its own object so it can never be
   * merged into the credit figure. Present only when an estimate is available.
   */
  conversion?: {
    from: SpendUnit;
    to: SpendUnit;
    rate: number;
    rateEnvVar: string;
    convertedLow: number;
    convertedHigh: number;
    caveat: string;
  };
  rates?: Record<string, unknown>;
  perSurface?: Array<Record<string, unknown>>;
  notes: string[];
}

/** Whether the work can proceed — `unknown` is a first-class answer. */
export type Affordability = 'affordable' | 'over-cap' | 'requires-approval' | 'unknown';

export interface AffordabilityVerdict {
  state: Affordability;
  reason: string;
  shortfallUnits: SpendUnit[];
}

/** "We could not read the balance" — never a boolean `fits`. */
export interface UnknownBalance {
  state: 'unknown';
  reason: string;
}

export interface KnownBalance {
  state: 'known';
  unit: SpendUnit;
  value: number;
  source: string;
  readAt: string;
}

export type ProviderBalance = KnownBalance | UnknownBalance;

export interface CostEstimateView {
  projectId: string;
  taskKind: string;
  requestedConfiguration: Record<string, unknown>;
  estimate: CostEstimate;
  policies: PolicyEvaluation[];
  unresolvedPolicies: UnresolvedPolicy[];
  bindingCeilings: BindingCeiling[];
  reservationRequired: true;
  reservationRationale: string;
  affordability: AffordabilityVerdict;
  providerBalances: ProviderBalance[];
  notes: string[];
}

export async function createCostEstimate(
  projectId: string,
  input: {
    taskKind: TaskKind;
    surfaces?: string[];
    prompts?: number;
    runCount?: number;
    markets?: number;
    requestedConfiguration?: Record<string, unknown>;
    checkProviderBalance?: boolean;
  },
) {
  return api.post<CostEstimateView>(`/projects/${projectId}/cost-estimates`, input);
}

export interface SpendEvent {
  id: string;
  projectId: string;
  taskKind: string | null;
  jobRunId: string | null;
  reservationId: string | null;
  provider: string;
  unit: SpendUnit;
  amount: number;
  quantity: number | null;
  quantityUnit: string | null;
  note: string | null;
  occurredAt: string;
  /** Literal: this row is a charge, unlike a reservation. */
  isActual: true;
}

export interface ReservationView {
  id: string;
  projectId: string;
  taskKind: string;
  jobRunId: string | null;
  estimate: { lowUsd: number; highUsd: number };
  /** What was set aside — **not** what was charged. */
  reserved: { usd: number; credits: number };
  status: string;
  expiredButUnswept: boolean;
  /** Null unless the reservation has been settled. */
  settled: { usd: number; credits: number } | null;
  variance: { vsHighUsd: number; vsLowUsd: number; note: string } | null;
  settledAt: string | null;
  expiresAt: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  /** Held with no approver — a `soft` ceiling was passed. */
  awaitingApproval: boolean;
  createdAt: string;
}

export interface SpendView {
  projectId: string;
  timezone: string;
  window: { from: string | null; to: string | null; note: string };
  /** Always both units, always separate. Never a single combined total. */
  totals: Array<{ unit: SpendUnit; settled: number; reservedHeld: number }>;
  reservationSummary: {
    held: number;
    settled: number;
    released: number;
    expired: number;
    awaitingApproval: number;
    expiredOnThisRead: number;
  };
  byProvider: Array<{
    provider: string;
    units: Array<{ unit: SpendUnit; settled: number; events: number }>;
  }>;
  events: SpendEvent[];
  reservations: ReservationView[];
  /** This route performs no probe, and says so rather than implying one. */
  balanceProbe: { performed: false; reason: string };
}

export async function getSpendView(
  projectId: string,
  query?: { from?: string; to?: string; taskKind?: string; provider?: string; unit?: SpendUnit; limit?: number },
  options?: { signal?: AbortSignal },
) {
  return api.get<SpendView>(`/projects/${projectId}/spend`, { ...options, query });
}

export async function listReservations(
  projectId: string,
  query?: { status?: ReservationStatus; taskKind?: string; awaitingApprovalOnly?: boolean; limit?: number },
  options?: { signal?: AbortSignal },
) {
  return api.get<{
    projectId: string;
    expiredOnThisRead: number;
    awaitingApprovalCount: number;
    reservations: ReservationView[];
  }>(`/projects/${projectId}/budget/reservations`, { ...options, query });
}

/**
 * Reserves spend **before** a run starts. The ceiling check and the hold commit
 * together, so two concurrent requests cannot both pass the same ceiling.
 *
 * A hold is not a charge: `getSpendView` reports `reservedHeld` and `settled`
 * as separate numbers per unit, and so must any screen built on this.
 */
export async function reserveSpend(
  projectId: string,
  input: {
    taskKind: TaskKind;
    jobRunId?: string;
    estimateLowUsd?: number;
    estimateHighUsd?: number;
    reservedUsd?: number;
    reservedCredits?: number;
    provider?: string;
    ttlMinutes?: number;
  },
) {
  return api.post<ReservationView & { approval?: unknown }>(
    `/projects/${projectId}/budget/reservations`,
    input,
  );
}

export async function approveReservation(projectId: string, reservationId: string) {
  return api.post<ReservationView>(
    `/projects/${projectId}/budget/reservations/${reservationId}/approve`,
  );
}

export async function releaseReservation(projectId: string, reservationId: string) {
  return api.post<ReservationView>(
    `/projects/${projectId}/budget/reservations/${reservationId}/release`,
  );
}

export async function settleReservation(
  projectId: string,
  reservationId: string,
  input: {
    settledUsd?: number;
    settledCredits?: number;
    provider?: string;
    quantity?: number;
    quantityUnit?: string;
    note?: string;
    acknowledgeOverReservation?: boolean;
  },
) {
  return api.post<ReservationView>(
    `/projects/${projectId}/budget/reservations/${reservationId}/settle`,
    input,
  );
}

/**
 * The project picker OP18 needs.
 *
 * Deliberately **not** `projects.ts#listProjects`: that adapter declares a bare
 * `ProjectSummary[]`, while the route returns the documented envelope
 * `{ projects: ProjectDto[] }`. Reusing it would produce `undefined` at
 * runtime and blank the picker. The discrepancy is reported rather than patched
 * in a file this build must not touch.
 */
export interface ProjectOption {
  id: string;
  name: string;
  domain: string;
  status: string;
  clientName: string | null;
}

export async function listProjectOptions(
  filter?: { status?: string; search?: string },
  options?: { signal?: AbortSignal },
) {
  const payload = await api.get<{ projects: ProjectOption[] }>('/projects', {
    ...options,
    query: filter,
  });
  return payload.projects;
}

// ── OP20 · Program and report templates ─────────────────────────────────

export const PROGRAM_TEMPLATE_KINDS = ['onboarding', 'cycle', 'offboarding'] as const;
export type ProgramTemplateKind = (typeof PROGRAM_TEMPLATE_KINDS)[number];

export const PROGRAM_ITEM_CATEGORIES = ['fix', 'build', 'influence'] as const;
export const PROGRAM_ITEM_DISCIPLINES = [
  'technical',
  'content',
  'authority',
  'research',
  'reporting',
  'access',
] as const;

export interface ProgramTemplateItem {
  title: string;
  category: string | null;
  discipline: string | null;
  /** Who the item is for — a role name, or a member/user id. */
  role: string | null;
  estimateHours: number | null;
  /** Days from the apply date. Without a `startOn` no due date is set. */
  offsetDays: number | null;
}

export interface ProgramTemplate {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  items: ProgramTemplateItem[];
  version: number;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** ⚠️ `active` is a **string** on the query string, not a boolean. */
export async function listProgramTemplates(
  filter?: { kind?: ProgramTemplateKind; active?: 'true' | 'false' },
  options?: { signal?: AbortSignal },
) {
  return api.get<{ templates: ProgramTemplate[] }>('/organization/program-templates', {
    ...options,
    query: filter,
  });
}

export async function getProgramTemplate(id: string, options?: { signal?: AbortSignal }) {
  return api.get<ProgramTemplate>(`/organization/program-templates/${id}`, options);
}

export async function createProgramTemplate(input: {
  name: string;
  kind: ProgramTemplateKind;
  description?: string;
  items?: ProgramTemplateItem[];
  active?: boolean;
}) {
  return api.post<ProgramTemplate>('/organization/program-templates', input);
}

/**
 * Edits a template. A **content** change bumps `version`; the earlier content is
 * not retrievable afterwards — these rows are mutated in place, unlike
 * organization settings, which are append-only. The screen states that
 * difference rather than implying a revision history that does not exist.
 */
export async function updateProgramTemplate(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    items: ProgramTemplateItem[];
    active: boolean;
  }>,
) {
  return api.patch<ProgramTemplate>(`/organization/program-templates/${id}`, patch);
}

export const REPORT_TYPES = ['monthly', 'quarterly', 'diagnostic', 'scorecard'] as const;

export interface ReportTemplateSection {
  key: string;
  title: string;
  include: boolean;
  order: number;
}

export interface ReportTemplate {
  id: string;
  name: string;
  reportType: string;
  sections: ReportTemplateSection[];
  version: number;
  isDefault: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listReportTemplates(
  reportType?: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<{ templates: ReportTemplate[] }>('/organization/report-templates', {
    ...options,
    query: reportType ? { reportType } : undefined,
  });
}

export async function createReportTemplate(input: {
  name: string;
  reportType: string;
  sections: ReportTemplateSection[];
  isDefault?: boolean;
}) {
  return api.post<ReportTemplate>('/organization/report-templates', input);
}

export async function updateReportTemplate(
  id: string,
  patch: Partial<{ name: string; sections: ReportTemplateSection[] }>,
) {
  return api.patch<ReportTemplate>(`/organization/report-templates/${id}`, patch);
}

export async function setDefaultReportTemplate(id: string) {
  return api.post<ReportTemplate>(`/organization/report-templates/${id}/default`);
}

// ── Project team activity (SL03 / OP19 context) ─────────────────────────

export async function listProjectActivity(
  projectId: string,
  query?: { resourceType?: string; limit?: number; cursor?: string },
  options?: { signal?: AbortSignal },
) {
  return api.get<{ events: ActivityEvent[]; nextCursor: string | null }>(
    `/projects/${projectId}/activity`,
    { ...options, query: query as Record<string, string | number | undefined> },
  );
}
