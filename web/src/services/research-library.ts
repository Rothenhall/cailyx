import { ApiError, api, unwrap } from '@/lib/api';

/**
 * Research-library adapters — the seven research modules behind
 * `/projects/:projectId/research/*` (QS01–QS02, EN01–EN02, DP01–DP02, CO01–CO02,
 * KW01, SP01–SP03, JO01–JO03).
 *
 * design_plan.md §10.2 is the reason this file is shaped the way it is: *"the
 * API mixes bare arrays with `{key: []}` wrappers"*, and reading an unexpected
 * shape as "no data" is how a failed read silently becomes an empty screen.
 * Every function below therefore states the envelope it actually expects and
 * **throws** when it gets something else, instead of coercing. The three shapes
 * in play, with the routes that use each:
 *
 * | Shape                    | Routes |
 * |--------------------------|--------|
 * | bare JSON array          | `GET /query-sets`, `GET /serp-trackers`, `GET /journeys`, `GET /journey-campaigns`, `GET /personas`, `GET /serp-trackers/:id/snapshots` |
 * | `{ key: [...] }` wrapper | `GET /entity-audit/entities`, `GET /keyword-research`, `GET /competitors/profiles`, `GET /competitors/candidates` |
 * | one object               | `GET /presence`, `GET /competitors/gap`, `GET /serp-trackers/market-visibility`, `GET /journeys/suggestions`, `GET /journeys/:id` |
 *
 * §1.5 is the other spine. These modules measure **different things over
 * different populations** — entity consistency, presence completeness,
 * competitor gap, SERP rank and counted AI-answer rates. Nothing in this file
 * combines them, and no function here returns a composite. Where two of them
 * are shown together the screens keep them numerically and visually separate.
 *
 * Two write-path rules this file respects rather than papers over:
 *
 *  - **Query-set activation and forking are the only way a set changes.**
 *    `POST /:setId/prompts` and `DELETE /:setId/prompts/:itemId` answer 409 for
 *    any set that is not `draft`; the service does not hide that behind a
 *    client-side check.
 *  - **Anything that spends money is an explicit, named call.** `discover`
 *    with `searchWeb`, `POST /social-activity` (Apify credit), `POST
 *    /keyword-research` (DataForSEO), `capture` (SERP vendor) and `execute`
 *    (per-step AI calls) are never invoked by a page's initial render.
 */

// ─── Envelope normalization (§10.2) ──────────────────────────────────────

function described(payload: unknown): string {
  if (payload === null) return 'null';
  if (payload === undefined) return 'nothing';
  if (Array.isArray(payload)) return 'a list';
  if (typeof payload === 'object') return 'an object';
  return `a ${typeof payload}`;
}

function shapeError(endpoint: string, expected: string, payload: unknown): ApiError {
  return new ApiError({
    kind: 'unknown',
    status: 0,
    message: `${endpoint} returned ${described(payload)} where ${expected} was expected.`,
    body: payload,
  });
}

/** A route that answers with a bare JSON array. */
function asList<T>(payload: unknown, endpoint: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  throw shapeError(endpoint, 'a list', payload);
}

/** A route that answers with one JSON object. */
function asRecord<T>(payload: unknown, endpoint: string): T {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload as T;
  throw shapeError(endpoint, 'an object', payload);
}

/** A route that wraps its list in a named key. */
function asKeyedList<T>(payload: unknown, key: string, endpoint: string): T[] {
  const value = unwrap<unknown>(payload, key);
  if (Array.isArray(value)) return value as T[];
  throw shapeError(`${endpoint} (?${key})`, 'a list', value);
}

/**
 * Project context for the screens' `ScopeBanner`.
 *
 * Kept here rather than imported from `services/projects.ts` so this file has
 * no dependency on a module another change may be editing, and so a page can
 * treat a failed scope read as its own, separately-reported condition.
 */
export interface ResearchScope {
  projectName: string;
  domain: string;
  clientName: string | null;
  category: string | null;
}

export async function getResearchScope(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<ResearchScope> {
  const endpoint = `GET /projects/${projectId}`;
  const raw = asRecord<Record<string, unknown>>(
    await api.get<unknown>(`/projects/${projectId}`, options),
    endpoint,
  );
  if (typeof raw.name !== 'string' || typeof raw.domain !== 'string') {
    throw shapeError(endpoint, 'a project with a name and a domain', raw);
  }
  return {
    projectName: raw.name,
    domain: raw.domain,
    clientName: typeof raw.clientName === 'string' ? raw.clientName : null,
    category: typeof raw.category === 'string' ? raw.category : null,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// QS01–QS02 · Query sets (buyer prompt library)
// ═════════════════════════════════════════════════════════════════════════

/**
 * An awareness-stage label. §5.6 step 4 is explicit that this is **not** a
 * `Persona` row: "Query-set `persona` is an awareness-stage label, distinct
 * from a row in the synthetic Persona module. Do not assume those two fields
 * are interchangeable foreign keys."
 */
export type PromptPersona = 'problem-aware' | 'solution-aware' | 'product-aware' | 'most-aware';
export type FunnelStage = PromptPersona;
export type QuerySetStatus = 'draft' | 'active' | 'archived';

export const PROMPT_PERSONAS: readonly PromptPersona[] = [
  'problem-aware',
  'solution-aware',
  'product-aware',
  'most-aware',
];

export const PROMPT_PERSONA_LABEL: Record<string, string> = {
  'problem-aware': 'Problem aware',
  'solution-aware': 'Solution aware',
  'product-aware': 'Product aware',
  'most-aware': 'Most aware',
};

/** A prompt row inside a set. */
export interface QuerySetItem {
  id: string;
  querySetId: string;
  prompt: string;
  funnelStage: string;
  /**
   * AEO-matrix provenance, set only on sets generated from a matrix:
   * `service-discovery | category-best-of | competitor-alternatives | …`.
   */
  dimension: string | null;
  /** JSON `{service?, competitor?, personaRole?, register?, geo?, template}`. */
  meta: string | null;
  createdAt: string;
}

export interface QuerySet {
  id: string;
  projectId: string;
  version: number;
  persona: string;
  label: string | null;
  status: string;
  /**
   * Where the prompts came from: `manual | sales-questions | support-tickets`
   * for human-curated sets, `aeo-matrix` for a generated matrix.
   */
  source: string;
  createdAt: string;
  activatedAt: string | null;
  items?: QuerySetItem[];
}

export async function listQuerySets(
  projectId: string,
  filter?: { status?: string },
  options?: { signal?: AbortSignal },
): Promise<QuerySet[]> {
  const endpoint = `GET /projects/${projectId}/query-sets`;
  const payload = await api.get<unknown>(`/projects/${projectId}/query-sets`, {
    ...options,
    query: { status: filter?.status },
  });
  return asList<QuerySet>(payload, endpoint);
}

/** One set with its items. */
export async function getQuerySet(
  projectId: string,
  setId: string,
  options?: { signal?: AbortSignal },
): Promise<QuerySet> {
  const endpoint = `GET /projects/${projectId}/query-sets/${setId}`;
  const payload = await api.get<unknown>(`/projects/${projectId}/query-sets/${setId}`, options);
  const set = asRecord<QuerySet>(payload, endpoint);
  if (!Array.isArray(set.items)) {
    throw shapeError(`${endpoint} (.items)`, 'a list of prompt rows', set.items);
  }
  return set;
}

/**
 * The full project export. Answers with a **bare array** of every set with all
 * prompt rows — the client owns the query set.
 */
export async function exportQuerySets(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<QuerySet[]> {
  const endpoint = `GET /projects/${projectId}/query-sets/export`;
  const payload = await api.get<unknown>(`/projects/${projectId}/query-sets/export`, options);
  return asList<QuerySet>(payload, endpoint);
}

/**
 * Create the version-1 draft for one awareness label.
 *
 * One v1 per project + persona: a second attempt answers **409** and the
 * server's own message says to fork instead. The screen shows that verbatim —
 * it is a real constraint, not a form error to smooth over.
 */
export async function createQuerySet(
  projectId: string,
  input: { persona: PromptPersona; label?: string; prompt?: string; funnelStage?: FunnelStage },
): Promise<QuerySet> {
  const endpoint = `POST /projects/${projectId}/query-sets`;
  const payload = await api.post<unknown>(`/projects/${projectId}/query-sets`, input);
  return asRecord<QuerySet>(payload, endpoint);
}

/** Add a prompt. **Draft sets only** — an active set answers 409. */
export async function addQuerySetPrompt(
  projectId: string,
  setId: string,
  input: { prompt: string; funnelStage: FunnelStage },
): Promise<QuerySetItem> {
  const endpoint = `POST /projects/${projectId}/query-sets/${setId}/prompts`;
  const payload = await api.post<unknown>(
    `/projects/${projectId}/query-sets/${setId}/prompts`,
    input,
  );
  return asRecord<QuerySetItem>(payload, endpoint);
}

/** Remove a prompt. **Draft sets only** — an active set answers 409. */
export async function removeQuerySetPrompt(
  projectId: string,
  setId: string,
  itemId: string,
): Promise<void> {
  await api.delete<unknown>(`/projects/${projectId}/query-sets/${setId}/prompts/${itemId}`);
}

/**
 * Activate a draft. Freezes the set: measurement runs reference this exact
 * version, and every later edit goes through a fork (§5.6 step 5).
 * Requires at least one prompt — an empty set answers 409.
 */
export async function activateQuerySet(projectId: string, setId: string): Promise<QuerySet> {
  const endpoint = `POST /projects/${projectId}/query-sets/${setId}/activate`;
  const payload = await api.post<unknown>(`/projects/${projectId}/query-sets/${setId}/activate`);
  const set = asRecord<QuerySet>(payload, endpoint);
  if (!Array.isArray(set.items)) {
    throw shapeError(`${endpoint} (.items)`, 'a list of prompt rows', set.items);
  }
  return set;
}

/**
 * Fork an **active or archived** set into the next draft version, copying every
 * prompt. A set that is still a draft answers 409 — it is already editable in
 * place.
 */
export async function forkQuerySet(projectId: string, setId: string): Promise<QuerySet> {
  const endpoint = `POST /projects/${projectId}/query-sets/${setId}/fork`;
  const payload = await api.post<unknown>(`/projects/${projectId}/query-sets/${setId}/fork`);
  const set = asRecord<QuerySet>(payload, endpoint);
  if (!Array.isArray(set.items)) {
    throw shapeError(`${endpoint} (.items)`, 'a list of prompt rows', set.items);
  }
  return set;
}

// ═════════════════════════════════════════════════════════════════════════
// EN01–EN02 · Entity registry and cross-platform identity
// ═════════════════════════════════════════════════════════════════════════

export type EntityType = 'brand' | 'product' | 'founder' | 'metric';
export const ENTITY_TYPES: readonly EntityType[] = ['brand', 'product', 'founder', 'metric'];

export interface Entity {
  id: string;
  entityAuditId?: string;
  name: string;
  descriptor: string | null;
  type: string;
  createdAt: string;
}

/** `match` — the same entity. `mismatch` — a different one. `not-checked` — nobody looked. */
export type ConsistencyStatus = 'match' | 'mismatch' | 'not-checked';
export type PlatformRecordStatus = ConsistencyStatus;

export interface PlatformRecord {
  id: string;
  entityId: string;
  platform: string;
  recordedName: string | null;
  recordedDescriptor: string | null;
  sourceUrl: string | null;
  consistencyStatus: string;
  createdAt: string;
}

export interface SameAsVerification {
  url: string;
  resolves: boolean;
  /** Null when the page could not be read, so no claim is made either way. */
  identityMatch: boolean | null;
  title: string | null;
  statusCode: number | null;
}

export interface SchemaCheck {
  id?: string;
  entityId: string;
  schemaType: string | null;
  fieldsPresent: string | null;
  fieldsMissing: string | null;
  sameAsCount: number;
  sameAsUrls: string | null;
  sameAsVerification: string | null;
  status: string;
  checkedAt: string;
  recommendedFix?: string;
}

export interface ModelDiff {
  id: string;
  entityId: string;
  prompt: string;
  provider: string;
  model: string | null;
  rawAnswer: string | null;
  citations: string | null;
  divergence: string | null;
  status: string;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
  checkedAt: string;
}

export interface EntityWithRecords extends Entity {
  schemaChecks: SchemaCheck[];
  platformRecords: PlatformRecord[];
  modelDiffs: ModelDiff[];
}

export interface PlatformConsistencyCheck {
  platform: string;
  recordedName: string | null;
  entityName: string;
  consistencyStatus: 'match' | 'mismatch';
  sourceUrl: string | null;
  fetchedTitle?: string | null;
}

/** Wrapped in `{ entities: [...] }`. */
export async function listEntities(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<EntityWithRecords[]> {
  const endpoint = `GET /projects/${projectId}/entity-audit/entities`;
  const payload = await api.get<unknown>(`/projects/${projectId}/entity-audit/entities`, options);
  return asKeyedList<EntityWithRecords>(payload, 'entities', endpoint);
}

/** One entity with its schema-check history, platform records and model diffs. */
export async function getEntity(
  projectId: string,
  entityId: string,
  options?: { signal?: AbortSignal },
): Promise<EntityWithRecords> {
  const endpoint = `GET /projects/${projectId}/entity-audit/entities/${entityId}`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/entity-audit/entities/${entityId}`,
    options,
  );
  return asRecord<EntityWithRecords>(payload, endpoint);
}

export async function createEntity(
  projectId: string,
  input: { name: string; type: EntityType; descriptor?: string },
): Promise<Entity> {
  const endpoint = `POST /projects/${projectId}/entity-audit/entities`;
  return asRecord<Entity>(
    await api.post<unknown>(`/projects/${projectId}/entity-audit/entities`, input),
    endpoint,
  );
}

/**
 * Partial update of name / descriptor / type.
 *
 * There is no `sameAs` field to edit here: `sameAs` is **read** from the
 * client's published JSON-LD by the schema check. Editing it means changing
 * the markup on the site, so this screen reports what the markup says rather
 * than offering a field that would only ever be a local fiction.
 */
export async function updateEntity(
  projectId: string,
  entityId: string,
  patch: { name?: string; descriptor?: string; type?: EntityType },
): Promise<Entity> {
  const endpoint = `PATCH /projects/${projectId}/entity-audit/entities/${entityId}`;
  return asRecord<Entity>(
    await api.patch<unknown>(`/projects/${projectId}/entity-audit/entities/${entityId}`, patch),
    endpoint,
  );
}

/**
 * Fetch JSON-LD from a URL, validate required fields, and verify each `sameAs`
 * link resolves and matches the entity's identity. Rate-limited to 5/minute.
 */
export async function runSchemaCheck(
  projectId: string,
  entityId: string,
  url: string,
): Promise<SchemaCheck> {
  const endpoint = `POST /projects/${projectId}/entity-audit/entities/${entityId}/schema-check/run`;
  return asRecord<SchemaCheck>(
    await api.post<unknown>(
      `/projects/${projectId}/entity-audit/entities/${entityId}/schema-check/run`,
      { url },
    ),
    endpoint,
  );
}

/** Wrapped in `{ entityId, checks, count }`. */
export async function listSchemaChecks(
  projectId: string,
  entityId: string,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<SchemaCheck[]> {
  const endpoint = `GET /projects/${projectId}/entity-audit/entities/${entityId}/schema-checks`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/entity-audit/entities/${entityId}/schema-checks`,
    { signal: options?.signal, query: { limit: options?.limit } },
  );
  return asKeyedList<SchemaCheck>(payload, 'checks', endpoint);
}

export async function createPlatformRecord(
  projectId: string,
  entityId: string,
  input: {
    platform: string;
    recordedName?: string;
    recordedDescriptor?: string;
    sourceUrl?: string;
    consistencyStatus?: ConsistencyStatus;
    /** Single-page fetch to auto-verify the recorded title. */
    verifySource?: boolean;
  },
): Promise<PlatformRecord> {
  const endpoint = `POST /projects/${projectId}/entity-audit/entities/${entityId}/platform-record`;
  return asRecord<PlatformRecord>(
    await api.post<unknown>(
      `/projects/${projectId}/entity-audit/entities/${entityId}/platform-record`,
      input,
    ),
    endpoint,
  );
}

export async function updatePlatformRecord(
  projectId: string,
  entityId: string,
  recordId: string,
  patch: {
    platform?: string;
    recordedName?: string;
    recordedDescriptor?: string;
    sourceUrl?: string;
    consistencyStatus?: ConsistencyStatus;
  },
): Promise<PlatformRecord> {
  const endpoint = `PATCH /projects/${projectId}/entity-audit/entities/${entityId}/platform-records/${recordId}`;
  return asRecord<PlatformRecord>(
    await api.patch<unknown>(
      `/projects/${projectId}/entity-audit/entities/${entityId}/platform-records/${recordId}`,
      patch,
    ),
    endpoint,
  );
}

export async function deletePlatformRecord(
  projectId: string,
  entityId: string,
  recordId: string,
): Promise<void> {
  await api.delete<unknown>(
    `/projects/${projectId}/entity-audit/entities/${entityId}/platform-records/${recordId}`,
  );
}

/** Wrapped in `{ entityId, checks }`. */
export async function getPlatformConsistency(
  projectId: string,
  entityId: string,
  options?: { signal?: AbortSignal },
): Promise<PlatformConsistencyCheck[]> {
  const endpoint = `GET /projects/${projectId}/entity-audit/entities/${entityId}/platform-consistency`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/entity-audit/entities/${entityId}/platform-consistency`,
    options,
  );
  return asKeyedList<PlatformConsistencyCheck>(payload, 'checks', endpoint);
}

/** Wrapped in `{ entityId, diffs, count }`. Empty until an identity check has run. */
export async function listModelDiffs(
  projectId: string,
  entityId: string,
  options?: { signal?: AbortSignal },
): Promise<ModelDiff[]> {
  const endpoint = `GET /projects/${projectId}/entity-audit/entities/${entityId}/model-diffs`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/entity-audit/entities/${entityId}/model-diffs`,
    options,
  );
  return asKeyedList<ModelDiff>(payload, 'diffs', endpoint);
}

/**
 * Ask every keyed AI surface "What is {entity}?" and run a judge pass for
 * divergence. **Spends provider credit** and answers 503 when no surface key is
 * configured — never called on page load.
 */
export async function runModelDiff(
  projectId: string,
  entityId: string,
  prompt?: string,
): Promise<{ runId: string; status: string; divergence: string | null; answers: number }> {
  const endpoint = `POST /projects/${projectId}/entity-audit/entities/${entityId}/model-diff/run`;
  return asRecord<{ runId: string; status: string; divergence: string | null; answers: number }>(
    await api.post<unknown>(
      `/projects/${projectId}/entity-audit/entities/${entityId}/model-diff/run`,
      prompt ? { prompt } : {},
    ),
    endpoint,
  );
}

// ═════════════════════════════════════════════════════════════════════════
// DP01–DP02 · Digital presence
// ═════════════════════════════════════════════════════════════════════════

/**
 * What we know about an account. Deliberately three-valued plus a candidate:
 * a profile linked from the client's own site that the platform then refused
 * to serve is `unverified`, **never** `missing`.
 */
export type PresenceState = 'confirmed' | 'unverified' | 'missing' | 'candidate';
export type PresenceSource = 'json-ld-sameas' | 'page-link' | 'manual' | 'serp';
export type PresenceEntity = 'company' | 'personal' | 'unknown';

export interface PresenceAccount {
  id: string;
  platform: string;
  label: string;
  group: string;
  url: string;
  handle: string | null;
  source: string;
  sourceLabel: string;
  entity: string;
  state: string;
  /** Verbatim reason the check could not complete. Set only when `unverified`. */
  reason: string | null;
  statusCode: number | null;
  title: string | null;
  foundOn: string | null;
  verifiedAt: string | null;
  nameConsistency: string;
  /** 0-1 name-similarity hint on `candidate` rows only. An ordering aid. */
  confidence: number | null;
}

export interface PresenceGap {
  platform: string;
  label: string;
  group: string;
}

export interface DiscoveryRun {
  id: string;
  status: string;
  pagesFetched: number;
  found: number;
  confirmed: number;
  unverified: number;
  candidates: number;
  serpQueries: number;
  serpCostUsd: number;
  /** Why the paid SERP phase did not run, when it did not. */
  serpSkipped: string | null;
  sources: Record<string, number> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** `not-checked` means no module has looked — not that the answer is "none". */
export interface FootprintItem {
  label: string;
  state: 'found' | 'none' | 'not-checked';
  detail: string | null;
  source: string;
}

export interface FootprintSection {
  key: string;
  label: string;
  items: FootprintItem[];
}

export interface CategoryCoverage {
  group: string;
  label: string;
  state: 'covered' | 'partial' | 'absent' | 'not-checked';
  held: number;
  missing: string[];
  note: string;
}

/** Three-valued on purpose: `not-built` ≠ `not-configured` ≠ `not-run`. */
export interface CapabilityNote {
  label: string;
  state: 'not-built' | 'not-configured' | 'not-run';
  note: string;
}

export interface PresenceAssessment {
  businessProfile: string;
  businessProfileLabel: string;
  inferredFrom: string | null;
  headlines: string[];
  coverage: CategoryCoverage[];
  notMeasured: CapabilityNote[];
}

export interface BusinessProfileSnapshot {
  id: string;
  source: string;
  name: string | null;
  categories: string[];
  hours: unknown | null;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  fetchedAt: string;
}

export interface ReviewSnapshot {
  id: string;
  platform: string;
  rating: number | null;
  reviewCount: number | null;
  url: string | null;
  /** `dataforseo` (paid Business Data) | `schema-scrape` (the listing's own AggregateRating). */
  source: string;
  fetchedAt: string;
}

export interface SocialActivitySummary {
  platform: string;
  followerCount: number | null;
  postsSampled: number;
  lastPostAt: string | null;
  avgEngagement: number | null;
}

export interface PresenceInventory {
  projectId: string;
  domain: string;
  accounts: PresenceAccount[];
  counts: {
    total: number;
    confirmed: number;
    unverified: number;
    social: number;
    listing: number;
    manual: number;
    candidates: number;
    personal: number;
  };
  gaps: PresenceGap[];
  footprint: FootprintSection[];
  assessment: PresenceAssessment;
  lastRun: DiscoveryRun | null;
  /** Null until a Business Data pull has happened — never a fabricated profile. */
  businessProfile: BusinessProfileSnapshot | null;
  reviews: ReviewSnapshot[];
  socialActivity: SocialActivitySummary[];
}

export async function getPresenceInventory(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<PresenceInventory> {
  const endpoint = `GET /projects/${projectId}/presence`;
  const payload = await api.get<unknown>(`/projects/${projectId}/presence`, options);
  const inventory = asRecord<PresenceInventory>(payload, endpoint);
  for (const [key, value] of [
    ['accounts', inventory.accounts],
    ['gaps', inventory.gaps],
    ['footprint', inventory.footprint],
    ['reviews', inventory.reviews],
    ['socialActivity', inventory.socialActivity],
  ] as const) {
    if (!Array.isArray(value)) {
      throw shapeError(`${endpoint} (.${key})`, 'a list', value);
    }
  }
  if (!inventory.assessment || !Array.isArray(inventory.assessment.coverage)) {
    throw shapeError(`${endpoint} (.assessment.coverage)`, 'a list', inventory.assessment);
  }
  return inventory;
}

export async function addPresenceAccount(projectId: string, url: string): Promise<PresenceAccount> {
  const endpoint = `POST /projects/${projectId}/presence/accounts`;
  return asRecord<PresenceAccount>(
    await api.post<unknown>(`/projects/${projectId}/presence/accounts`, { url }),
    endpoint,
  );
}

export async function updatePresenceAccount(
  projectId: string,
  accountId: string,
  url: string,
): Promise<PresenceAccount> {
  const endpoint = `PATCH /projects/${projectId}/presence/accounts/${accountId}`;
  return asRecord<PresenceAccount>(
    await api.patch<unknown>(`/projects/${projectId}/presence/accounts/${accountId}`, { url }),
    endpoint,
  );
}

export async function removePresenceAccount(projectId: string, accountId: string): Promise<void> {
  await api.delete<unknown>(`/projects/${projectId}/presence/accounts/${accountId}`);
}

/**
 * Promote a SERP-suggested candidate to a real account. The human yes/no is the
 * only thing that promotes one: search cannot tell the client's account from a
 * similarly named stranger's.
 */
export async function confirmPresenceCandidate(
  projectId: string,
  accountId: string,
): Promise<PresenceAccount> {
  const endpoint = `POST /projects/${projectId}/presence/accounts/${accountId}/confirm`;
  return asRecord<PresenceAccount>(
    await api.post<unknown>(`/projects/${projectId}/presence/accounts/${accountId}/confirm`),
    endpoint,
  );
}

/**
 * Crawl the client's own site for profile links. Free by default.
 *
 * `searchWeb: true` additionally sweeps Google — **one paid credit per platform
 * searched** — so it is an explicit opt-in on the screen, never a default.
 */
export async function runPresenceDiscovery(
  projectId: string,
  searchWeb: boolean,
): Promise<DiscoveryRun> {
  const endpoint = `POST /projects/${projectId}/presence/discover`;
  return asRecord<DiscoveryRun>(
    await api.post<unknown>(`/projects/${projectId}/presence/discover`, { searchWeb }),
    endpoint,
  );
}

/** Discovery-run history, newest first. Answers with a **bare array**. */
export async function listPresenceDiscoveries(
  projectId: string,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<DiscoveryRun[]> {
  const endpoint = `GET /projects/${projectId}/presence/discoveries`;
  const payload = await api.get<unknown>(`/projects/${projectId}/presence/discoveries`, {
    signal: options?.signal,
    query: { limit: options?.limit },
  });
  return asList<DiscoveryRun>(payload, endpoint);
}

/**
 * Apify social-activity pull. **Spends real account credit** — `confirmSpend`
 * is required on every call, mirroring `searchWeb` on discover: there is no
 * default path that reaches this.
 */
export async function runSocialActivity(
  projectId: string,
  input: { confirmSpend: true; platforms?: string[]; postsPerPlatform?: number },
): Promise<{
  requested: string[];
  skipped: Array<{ platform: string; reason: string }>;
  pulled: unknown[];
  totalCostUsd: number;
  errors: Array<{ platform: string; role: string; error: string }>;
}> {
  const endpoint = `POST /projects/${projectId}/presence/social-activity`;
  return asRecord(
    await api.post<unknown>(`/projects/${projectId}/presence/social-activity`, input),
    endpoint,
  );
}

export interface BrandVoiceRead {
  id: string;
  createdAt: string;
  projectId: string;
  domain: string;
  tone: string[];
  themes: string[];
  vocabulary: string[];
  callToActions: string[];
  summary: string | null;
  postSample: number;
  byPlatform: Array<{ platform: string; postSample: number; tone: string[]; themes: string[] }>;
  /** `insufficient-data` rather than a guess when there are too few captions. */
  extraction: 'llm-synthesized' | 'insufficient-data';
  llmModel: string | null;
  costUsd: number;
}

/** The latest stored read. A **404** means none has been built yet. */
export async function getBrandVoice(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<BrandVoiceRead> {
  const endpoint = `GET /projects/${projectId}/presence/brand-voice`;
  return asRecord<BrandVoiceRead>(
    await api.get<unknown>(`/projects/${projectId}/presence/brand-voice`, options),
    endpoint,
  );
}

/** Synthesize the read from stored captions. Needs ≥3 captions and an LLM. */
export async function buildBrandVoice(projectId: string): Promise<BrandVoiceRead> {
  const endpoint = `POST /projects/${projectId}/presence/brand-voice`;
  return asRecord<BrandVoiceRead>(
    await api.post<unknown>(`/projects/${projectId}/presence/brand-voice`),
    endpoint,
  );
}

/**
 * DataForSEO Business Data pull. Returns 503 naming the exact missing env var
 * rather than an empty profile.
 */
export async function pullBusinessProfile(
  projectId: string,
  input?: { businessName?: string; locationName?: string },
): Promise<unknown> {
  return api.post<unknown>(
    `/projects/${projectId}/presence/business-profile`,
    input && (input.businessName || input.locationName) ? input : {},
  );
}

/**
 * Read the `AggregateRating` every already-discovered ratable listing publishes
 * about itself. No vendor, no per-lookup cost; a listing that declares no
 * rating writes nothing, which is a fact about the listing.
 */
export async function pullDirectoryRatings(projectId: string): Promise<unknown> {
  return api.post<unknown>(`/projects/${projectId}/presence/directory-ratings`);
}

// ═════════════════════════════════════════════════════════════════════════
// CO01–CO02 · Competitors
// ═════════════════════════════════════════════════════════════════════════

export interface NamedCompetitor {
  name: string;
  domain: string | null;
  /** `project-json` | `manual` | `aeo-answer` | … */
  source?: string;
}

export interface SerpDiscoveredDomain {
  domain: string;
  appearances: number;
  bestRank: number | null;
  keyword: string | null;
}

/**
 * The named benchmark list plus domains discovered from **stored** SERP data.
 * Discovery is deterministic — first-page organic domains already on file — so
 * there is no extra fetching and no spend behind this read.
 */
export interface NamedCompetitorList {
  tracked: NamedCompetitor[];
  discovered: SerpDiscoveredDomain[];
  readiness: { rivals: number; runs: number; observations: number };
  you: { total: number; mentioned: number; cited: number };
  rivals: Array<{ name: string; appearances: number; share: number; beatYou: number }>;
  losing: Array<{ prompt: string; surface: string; rivals: string[] }>;
}

export async function getNamedCompetitors(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<NamedCompetitorList> {
  const endpoint = `GET /projects/${projectId}/competitors`;
  const payload = await api.get<unknown>(`/projects/${projectId}/competitors`, options);
  const result = asRecord<NamedCompetitorList>(payload, endpoint);
  if (!Array.isArray(result.tracked) || !Array.isArray(result.discovered)) {
    throw shapeError(`${endpoint} (.tracked/.discovered)`, 'two lists', result);
  }
  return result;
}

/**
 * **Replace** the named-competitor list — the exact set every share-of-voice
 * measurement benchmarks against, so an empty list means no benchmark is
 * produced at all. The screen confirms this with the resulting list shown.
 */
export async function setNamedCompetitors(
  projectId: string,
  competitors: NamedCompetitor[],
): Promise<NamedCompetitorList> {
  const endpoint = `PUT /projects/${projectId}/competitors`;
  const payload = await api.put<unknown>(`/projects/${projectId}/competitors`, { competitors });
  return asRecord<NamedCompetitorList>(payload, endpoint);
}

export interface CompetitorPresenceAccount {
  platform: string;
  label: string;
  group: string;
  url: string;
  handle: string | null;
  state: string;
}

export interface AttachedAeoStanding {
  name: string;
  observations: number;
  mentionRate: number;
  clientAheadCount: number;
  clientBehindCount: number;
  wonWhileClientAbsent: number;
  shareOfVoice: number | null;
  auditId: string;
  generatedAt: string | null;
}

export interface CompetitorContentSignals {
  wordCount: number;
  h1Count: number;
  headingCount: number;
  imageCount: number;
  imagesMissingAlt: number;
  titleLength: number | null;
  metaDescriptionLength: number | null;
  jsonLdCount: number;
  noindex: boolean;
}

/** `found: false` is kept — "on G2 but publishes no rating" ≠ "not on G2". */
export interface CompetitorReviewRating {
  platform: string;
  label: string;
  url: string;
  found: boolean;
  rating: number | null;
  ratingCount: number | null;
  scale: number | null;
}

export interface AttachedSerpPresence {
  occurrences: number;
  bestRank: number | null;
  sampleKeyword: string | null;
  capturedAt: string | null;
}

export interface CompetitorProfile {
  id: string;
  competitorId: string;
  domain: string | null;
  status: string;
  error: string | null;
  techScanId: string | null;
  schemaTypes: string[];
  presenceStatus: string;
  presenceAccounts: CompetitorPresenceAccount[];
  presenceError: string | null;
  /** `unknown` = no completed AEO audit exists at all — nothing to attach. */
  aeoStatus: string;
  aeoStanding: AttachedAeoStanding | null;
  serpStatus: string;
  serpPresence: AttachedSerpPresence | null;
  seoStatus: string;
  seoScore: number | null;
  seoIssues: string[];
  seoError: string | null;
  contentSignals: CompetitorContentSignals | null;
  reviewStatus: string;
  reviewRatings: CompetitorReviewRating[];
  reviewError: string | null;
  createdAt: string;
}

/**
 * A competitor row as stored. The candidate routes return exactly this — a
 * `status: "candidate"` row has **no** profile, because candidates are never
 * profiled until a human confirms them. Typing those routes as `CompetitorWithProfile`
 * would claim a `latestProfile` that is not there.
 */
export interface CompetitorRecord {
  id: string;
  projectId: string;
  name: string;
  domain: string | null;
  source: string;
  status: string;
  createdAt: string;
}

export interface CompetitorWithProfile extends CompetitorRecord {
  latestProfile: CompetitorProfile | null;
}

/** Wrapped in `{ competitors: [...] }`. Candidates are excluded by the server. */
export async function listCompetitorProfiles(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<CompetitorWithProfile[]> {
  const endpoint = `GET /projects/${projectId}/competitors/profiles`;
  const payload = await api.get<unknown>(`/projects/${projectId}/competitors/profiles`, options);
  return asKeyedList<CompetitorWithProfile>(payload, 'competitors', endpoint);
}

/**
 * Wrapped in `{ candidates: [...] }` — rows with `status: "candidate"`.
 * Unprofiled by construction: a candidate is a name an AI surface mentioned,
 * and nothing has crawled it.
 */
export async function listCompetitorCandidates(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<CompetitorRecord[]> {
  const endpoint = `GET /projects/${projectId}/competitors/candidates`;
  const payload = await api.get<unknown>(`/projects/${projectId}/competitors/candidates`, options);
  return asKeyedList<CompetitorRecord>(payload, 'candidates', endpoint);
}

/** Promote a candidate. Also appends it to the named list every other module reads. */
export async function confirmCompetitorCandidate(
  projectId: string,
  competitorId: string,
): Promise<CompetitorRecord> {
  const endpoint = `POST /projects/${projectId}/competitors/candidates/${competitorId}/confirm`;
  return asRecord<CompetitorRecord>(
    await api.post<unknown>(
      `/projects/${projectId}/competitors/candidates/${competitorId}/confirm`,
    ),
    endpoint,
  );
}

/** Reject and delete an **unconfirmed** candidate. */
export async function rejectCompetitorCandidate(
  projectId: string,
  competitorId: string,
): Promise<void> {
  await api.delete<unknown>(`/projects/${projectId}/competitors/candidates/${competitorId}`);
}

/** Promote `Project.competitors` (+ an explicit list) into profiled rows. 5/minute. */
export async function discoverCompetitors(
  projectId: string,
  input?: { competitors?: NamedCompetitor[] },
): Promise<{ projectId: string; totalCompetitors: number; promoted: number; competitors: CompetitorWithProfile[] }> {
  const endpoint = `POST /projects/${projectId}/competitors/discover`;
  return asRecord(
    await api.post<unknown>(`/projects/${projectId}/competitors/discover`, input ?? {}),
    endpoint,
  );
}

/** One line of the tech/schema/presence diff. Presence diffs, **not** scores. */
export interface GapDiffLine {
  key: string;
  client: boolean;
  competitors: string[];
}

export interface GapCompetitorRow {
  competitorId: string;
  name: string;
  domain: string | null;
  aeoStatus: string;
  aeoStanding: AttachedAeoStanding | null;
  serpStatus: string;
  serpPresence: AttachedSerpPresence | null;
  presencePlatforms: string[];
  seoScore: number | null;
  seoIssues: string[];
  contentSignals: CompetitorContentSignals | null;
  reviewRatings: CompetitorReviewRating[];
}

export interface GapResult {
  projectId: string;
  domain: string;
  generatedAt: string;
  tech: { client: string[]; clientOnly: GapDiffLine[]; competitorsOnly: GapDiffLine[]; shared: GapDiffLine[] };
  schema: { client: string[]; clientOnly: GapDiffLine[]; competitorsOnly: GapDiffLine[]; shared: GapDiffLine[] };
  presence: { client: string[]; clientOnly: GapDiffLine[]; competitorsOnly: GapDiffLine[]; shared: GapDiffLine[] };
  seo: {
    client: {
      score: number | null;
      issues: string[];
      contentSignals: CompetitorContentSignals | null;
    };
    note: string;
  };
  reviews: {
    client: Array<{ platform: string; label: string; rating: number | null; ratingCount: number | null; url?: string | null }>;
    note: string;
  };
  competitors: GapCompetitorRow[];
  note: string;
}

export async function getCompetitorGap(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<GapResult> {
  const endpoint = `GET /projects/${projectId}/competitors/gap`;
  const payload = await api.get<unknown>(`/projects/${projectId}/competitors/gap`, options);
  const gap = asRecord<GapResult>(payload, endpoint);
  if (!Array.isArray(gap.competitors)) {
    throw shapeError(`${endpoint} (.competitors)`, 'a list of competitor rows', gap.competitors);
  }
  return gap;
}

// ═════════════════════════════════════════════════════════════════════════
// KW01 · Keyword research
// ═════════════════════════════════════════════════════════════════════════

export interface KeywordRow {
  id: string;
  keyword: string;
  searchVolume: number | null;
  /**
   * LOW | MEDIUM | HIGH — the vendor's **advertiser-competition** bucket. A
   * demand-pressure proxy, not an organic ranking-difficulty score.
   */
  competition: string | null;
  competitionIndex: number | null;
  cpc: number | null;
  lowTopOfPageBid: number | null;
  highTopOfPageBid: number | null;
  /** False for the operator's own seeds, true for an expansion suggestion. */
  isRelated: boolean;
  isLongTail: boolean;
  createdAt: string;
}

export interface KeywordSet {
  id: string;
  projectId: string;
  seedInput: string[];
  locationName: string | null;
  languageCode: string | null;
  /** `partial` = seed volumes saved but the related expansion call failed. */
  status: 'pending' | 'completed' | 'partial' | 'failed';
  error: string | null;
  /** The vendor's own reported charge. Never estimated. */
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
  keywords: KeywordRow[];
}

/** Wrapped in `{ sets: [...] }`. Pass `setId` for exactly one set. */
export async function listKeywordSets(
  projectId: string,
  filter?: { setId?: string; minVolume?: number },
  options?: { signal?: AbortSignal },
): Promise<KeywordSet[]> {
  const endpoint = `GET /projects/${projectId}/keyword-research`;
  const payload = await api.get<unknown>(`/projects/${projectId}/keyword-research`, {
    ...options,
    query: { setId: filter?.setId, minVolume: filter?.minVolume },
  });
  return asKeyedList<KeywordSet>(payload, 'sets', endpoint);
}

/**
 * Pull live volume/competition/CPC plus an optional related expansion.
 *
 * Runs synchronously, and is a **paid vendor call** (DataForSEO) — 503 without
 * `SWARM_ALLOW_LIVE=1` + credentials. Never called on page load.
 */
export async function runKeywordResearch(
  projectId: string,
  input: {
    keywords: string[];
    locationName?: string;
    languageCode?: string;
    includeRelated?: boolean;
  },
): Promise<KeywordSet> {
  const endpoint = `POST /projects/${projectId}/keyword-research`;
  const set = asRecord<KeywordSet>(
    await api.post<unknown>(`/projects/${projectId}/keyword-research`, input),
    endpoint,
  );
  if (!Array.isArray(set.keywords)) {
    throw shapeError(`${endpoint} (.keywords)`, 'a list of keyword rows', set.keywords);
  }
  return set;
}

export interface PriorityKeyword extends KeywordRow {
  /** 0-100 over disclosed weights — every input is a real field on the row. */
  priorityScore: number;
}

export interface PriorityKeywordsResult {
  setId: string;
  rankedAt: string;
  weights: { volume: number; competition: number; commercialIntent: number };
  keywords: PriorityKeyword[];
  /** Keywords with no volume data — excluded from ranking, never dropped. */
  unscored: KeywordRow[];
}

export async function getPriorityKeywords(
  projectId: string,
  filter?: { setId?: string; limit?: number },
  options?: { signal?: AbortSignal },
): Promise<PriorityKeywordsResult> {
  const endpoint = `GET /projects/${projectId}/keyword-research/priority`;
  const payload = await api.get<unknown>(`/projects/${projectId}/keyword-research/priority`, {
    ...options,
    query: { setId: filter?.setId, limit: filter?.limit },
  });
  const result = asRecord<PriorityKeywordsResult>(payload, endpoint);
  if (!Array.isArray(result.keywords) || !Array.isArray(result.unscored)) {
    throw shapeError(`${endpoint} (.keywords/.unscored)`, 'two lists', result);
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════
// SP01–SP03 · SERP intelligence
// ═════════════════════════════════════════════════════════════════════════

export type SerpDevice = 'desktop' | 'mobile';
export type SerpProvider = 'dataforseo' | 'fixture';

export interface SerpQuery {
  id: string;
  trackerId: string;
  keyword: string;
  createdAt: string;
}

export interface SerpTracker {
  id: string;
  projectId: string;
  name: string;
  locationName: string;
  languageCode: string;
  device: string;
  provider: string;
  status: string;
  createdAt: string;
  queries?: SerpQuery[];
  snapshots?: SerpSnapshot[];
}

export interface SerpSnapshot {
  id: string;
  trackerId: string;
  provider: string;
  /** running | complete | partial | failed */
  status: string;
  queriesRun: number;
  costUsd: number;
  note: string | null;
  error: string | null;
  capturedAt: string;
  finishedAt: string | null;
}

export interface LocalPackEntry {
  title: string | null;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  domain: string | null;
  url: string | null;
}

/**
 * One keyword's captured result.
 *
 * `subjectRank` is a **search position**. `aiOverview*` are **counted
 * occurrences of an AI Overview and of the subject inside it**. §1.5 keeps
 * these apart: a rank is not an answer-engine rate, and the screens never blend
 * them into one figure.
 */
export interface SerpResult {
  id: string;
  snapshotId: string;
  queryId: string;
  keyword: string;
  subjectRank: number | null;
  subjectUrl: string | null;
  aiOverviewPresent: boolean;
  aiOverviewMentionsSubject: boolean;
  featuredSnippetDomain: string | null;
  topDomains: string;
  competitorsSeen: string;
  sourceCount: number;
  rawItemCount: number;
  costUsd: number;
  capturedAt: string;
  /** False when a local pack is not a meaningful question for this business. */
  localPackApplicable: boolean;
  /** Printed verbatim — the gate is never silent. */
  localPackReason: string | null;
  localPackPresent: boolean | null;
  localPackRank: number | null;
  localPackEntries: string;
}

export interface SerpSnapshotDetail extends SerpSnapshot {
  results: SerpResult[];
}

export interface CaptureRollup {
  snapshotId: string;
  status: string;
  queriesRun: number;
  costUsd: number;
  note: string | null;
}

/** Answers with a **bare array** of trackers, each with its queries. */
export async function listSerpTrackers(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<SerpTracker[]> {
  const endpoint = `GET /projects/${projectId}/serp-trackers`;
  const payload = await api.get<unknown>(`/projects/${projectId}/serp-trackers`, options);
  return asList<SerpTracker>(payload, endpoint);
}

/** Tracker + queries + the five most recent snapshots. */
export async function getSerpTracker(
  projectId: string,
  trackerId: string,
  options?: { signal?: AbortSignal },
): Promise<SerpTracker> {
  const endpoint = `GET /projects/${projectId}/serp-trackers/${trackerId}`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/serp-trackers/${trackerId}`,
    options,
  );
  const tracker = asRecord<SerpTracker>(payload, endpoint);
  if (!Array.isArray(tracker.queries)) {
    throw shapeError(`${endpoint} (.queries)`, 'a list of tracked keywords', tracker.queries);
  }
  return tracker;
}

export async function createSerpTracker(
  projectId: string,
  input: {
    name: string;
    keywords: string[];
    locationName?: string;
    languageCode?: string;
    device?: SerpDevice;
    provider?: SerpProvider;
  },
): Promise<SerpTracker> {
  const endpoint = `POST /projects/${projectId}/serp-trackers`;
  return asRecord<SerpTracker>(
    await api.post<unknown>(`/projects/${projectId}/serp-trackers`, input),
    endpoint,
  );
}

export async function addSerpQueries(
  projectId: string,
  trackerId: string,
  keywords: string[],
): Promise<SerpTracker> {
  const endpoint = `POST /projects/${projectId}/serp-trackers/${trackerId}/queries`;
  return asRecord<SerpTracker>(
    await api.post<unknown>(`/projects/${projectId}/serp-trackers/${trackerId}/queries`, {
      keywords,
    }),
    endpoint,
  );
}

export async function removeSerpQuery(
  projectId: string,
  trackerId: string,
  queryId: string,
): Promise<void> {
  await api.delete<unknown>(
    `/projects/${projectId}/serp-trackers/${trackerId}/queries/${queryId}`,
  );
}

/**
 * Capture a snapshot. **Paid vendor call**, bounded by a server-side USD cap —
 * it stops at the cap and says how many queries went unrun. Never called on
 * page load.
 */
export async function captureSerpSnapshot(
  projectId: string,
  trackerId: string,
  input?: { provider?: SerpProvider },
): Promise<CaptureRollup> {
  const endpoint = `POST /projects/${projectId}/serp-trackers/${trackerId}/capture`;
  return asRecord<CaptureRollup>(
    await api.post<unknown>(
      `/projects/${projectId}/serp-trackers/${trackerId}/capture`,
      input ?? {},
    ),
    endpoint,
  );
}

/** Bare array of snapshots, newest first. */
export async function listSerpSnapshots(
  projectId: string,
  trackerId: string,
  options?: { signal?: AbortSignal },
): Promise<SerpSnapshot[]> {
  const endpoint = `GET /projects/${projectId}/serp-trackers/${trackerId}/snapshots`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/serp-trackers/${trackerId}/snapshots`,
    options,
  );
  return asList<SerpSnapshot>(payload, endpoint);
}

export async function getSerpSnapshot(
  projectId: string,
  trackerId: string,
  snapshotId: string,
  options?: { signal?: AbortSignal },
): Promise<SerpSnapshotDetail> {
  const endpoint = `GET /projects/${projectId}/serp-trackers/${trackerId}/snapshots/${snapshotId}`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/serp-trackers/${trackerId}/snapshots/${snapshotId}`,
    options,
  );
  const snapshot = asRecord<SerpSnapshotDetail>(payload, endpoint);
  if (!Array.isArray(snapshot.results)) {
    throw shapeError(`${endpoint} (.results)`, 'a list of per-keyword results', snapshot.results);
  }
  return snapshot;
}

export async function deleteSerpTracker(projectId: string, trackerId: string): Promise<void> {
  await api.delete<unknown>(`/projects/${projectId}/serp-trackers/${trackerId}`);
}

export interface MarketVisibilityRow {
  location: string;
  trackers: string[];
  keywordsTracked: number;
  keywordsRanked: number;
  averageRank: number | null;
  aiOverviewKeywords: number;
  aiOverviewMentioned: number;
  /** `applicable: false` means a local-pack question is meaningless here. */
  localPack:
    | { applicable: true; keywordsChecked: number; keywordsPresent: number }
    | { applicable: false };
  topCompetitors: Array<{ name: string; keywordsAppearedIn: number }>;
}

export interface MarketVisibility {
  projectId: string;
  markets: MarketVisibilityRow[];
  note: string;
}

/**
 * Per-market rollup over each tracker's latest captured result per keyword.
 * **Never a fresh SERP fetch** — a market with no tracker simply does not
 * appear, which is "not measured", not "no visibility".
 */
export async function getMarketVisibility(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<MarketVisibility> {
  const endpoint = `GET /projects/${projectId}/serp-trackers/market-visibility`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/serp-trackers/market-visibility`,
    options,
  );
  const result = asRecord<MarketVisibility>(payload, endpoint);
  if (!Array.isArray(result.markets)) {
    throw shapeError(`${endpoint} (.markets)`, 'a list of markets', result.markets);
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════
// JO01–JO03 · Journeys and campaigns
// ═════════════════════════════════════════════════════════════════════════

export type JourneySurface = 'mock' | 'claude' | 'perplexity';
export const JOURNEY_SURFACES: readonly JourneySurface[] = ['mock', 'claude', 'perplexity'];

export interface JourneyStep {
  id: string;
  journeyId: string;
  parentId: string | null;
  depth: number;
  ordinal: number;
  kind: string;
  awareness: string;
  query: string;
  rationale: string;
  /** pending | done | failed | skipped */
  status: string;
  /**
   * The model's raw answer. Rendered as escaped text in the `.evidence`
   * utility — never as markup (§10.5).
   */
  answerText: string | null;
  /** JSON string[] of cited URLs. */
  citations: string;
  mentioned: boolean;
  cited: boolean;
  citedUrl: string | null;
  position: number | null;
  /** JSON string[] of competitor names seen in the answer. */
  competitorsSeen: string;
  costUsd: number;
  latencyMs: number | null;
  model: string | null;
  executedAt: string | null;
  createdAt: string;
}

export interface Journey {
  id: string;
  projectId: string;
  personaId: string;
  campaignId: string | null;
  label: string;
  objective: string;
  surface: string;
  geo: string;
  maxDepth: number;
  maxBranches: number;
  planSource: string;
  planModel: string | null;
  status: string;
  stepCount: number;
  executedSteps: number;
  mentionedSteps: number;
  citedSteps: number;
  costUsd: number;
  note: string | null;
  error: string | null;
  plannedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps?: JourneyStep[];
}

export interface JourneyCampaign {
  id: string;
  projectId: string;
  name: string;
  surface: string;
  geo: string;
  planSource: string;
  journeyTarget: number;
  maxDepth: number;
  maxBranches: number;
  /** JSON string[] — role filter; empty means any active persona. */
  personaRoles: string;
  budgetUsd: number;
  spentUsd: number;
  status: string;
  journeysPlanned: number;
  journeysExecuted: number;
  note: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  journeys?: Journey[];
}

export interface SuggestionLeaf {
  text: string;
  source: string;
  painPoint: string;
  suggestion: string;
}

export interface SuggestionWheel {
  hub: { label: string; domain: string; category: string };
  stages: Array<{ key: string; label: string; themes: Array<{ label: string; queries: SuggestionLeaf[] }> }>;
  boosts: Array<{
    id: string;
    lane: string;
    title: string;
    why: string;
    action: string;
    evidence: string;
    effort: string;
  }>;
  total: number;
  boostCount: number;
  generatedAt: string;
}

export interface Persona {
  id: string;
  projectId: string;
  label: string;
  role: string;
  seniority: string;
  companyStage: string;
  awareness: string;
  primaryGoal: string;
  researchObjective: string;
  status: string;
  source: string;
  createdAt: string;
}

export interface ExecuteJourneyRollup {
  journeyId: string;
  status: string;
  stepCount: number;
  executedSteps: number;
  mentionedSteps: number;
  citedSteps: number;
  costUsd: number;
  note: string | null;
}

/** Bare array, optionally filtered by status. */
export async function listJourneys(
  projectId: string,
  filter?: { status?: string },
  options?: { signal?: AbortSignal },
): Promise<Journey[]> {
  const endpoint = `GET /projects/${projectId}/journeys`;
  const payload = await api.get<unknown>(`/projects/${projectId}/journeys`, {
    ...options,
    query: { status: filter?.status },
  });
  return asList<Journey>(payload, endpoint);
}

/** One journey with its full ordered step tree (depth, then ordinal). */
export async function getJourney(
  projectId: string,
  journeyId: string,
  options?: { signal?: AbortSignal },
): Promise<Journey> {
  const endpoint = `GET /projects/${projectId}/journeys/${journeyId}`;
  const payload = await api.get<unknown>(`/projects/${projectId}/journeys/${journeyId}`, options);
  const journey = asRecord<Journey>(payload, endpoint);
  if (!Array.isArray(journey.steps)) {
    throw shapeError(`${endpoint} (.steps)`, 'a list of steps', journey.steps);
  }
  return journey;
}

/**
 * Plan a branching journey for one persona. **Executes nothing** — the cost is
 * incurred by `executeJourney`.
 */
export async function planJourney(
  projectId: string,
  input: {
    personaId: string;
    surface?: JourneySurface;
    geo?: string;
    maxDepth?: number;
    maxBranches?: number;
    useLlm?: boolean;
  },
): Promise<Journey> {
  const endpoint = `POST /projects/${projectId}/journeys/plan`;
  const journey = asRecord<Journey>(
    await api.post<unknown>(`/projects/${projectId}/journeys/plan`, input),
    endpoint,
  );
  if (!Array.isArray(journey.steps)) {
    throw shapeError(`${endpoint} (.steps)`, 'a list of steps', journey.steps);
  }
  return journey;
}

/**
 * Walk the pending steps against the surface adapter. **This is the
 * spend-incurring step** — it stops at the USD cap and reports how many steps
 * remain. Pass `maxCostUsd: 0` to stop before any spend.
 */
export async function executeJourney(
  projectId: string,
  journeyId: string,
  maxCostUsd?: number,
): Promise<ExecuteJourneyRollup> {
  const endpoint = `POST /projects/${projectId}/journeys/${journeyId}/execute`;
  return asRecord<ExecuteJourneyRollup>(
    await api.post<unknown>(`/projects/${projectId}/journeys/${journeyId}/execute`, undefined, {
      query: { maxCostUsd },
    }),
    endpoint,
  );
}

export async function deleteJourney(projectId: string, journeyId: string): Promise<void> {
  await api.delete<unknown>(`/projects/${projectId}/journeys/${journeyId}`);
}

/** Deterministic buyer-query wheel from planner templates + personas. No LLM, no spend. */
export async function getSuggestionWheel(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<SuggestionWheel> {
  const endpoint = `GET /projects/${projectId}/journeys/suggestions`;
  const payload = await api.get<unknown>(`/projects/${projectId}/journeys/suggestions`, options);
  const wheel = asRecord<SuggestionWheel>(payload, endpoint);
  if (!Array.isArray(wheel.stages) || !Array.isArray(wheel.boosts)) {
    throw shapeError(`${endpoint} (.stages/.boosts)`, 'two lists', wheel);
  }
  return wheel;
}

/** Bare array of campaigns, newest first. */
export async function listJourneyCampaigns(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<JourneyCampaign[]> {
  const endpoint = `GET /projects/${projectId}/journey-campaigns`;
  const payload = await api.get<unknown>(`/projects/${projectId}/journey-campaigns`, options);
  return asList<JourneyCampaign>(payload, endpoint);
}

export async function getJourneyCampaign(
  projectId: string,
  campaignId: string,
  options?: { signal?: AbortSignal },
): Promise<JourneyCampaign> {
  const endpoint = `GET /projects/${projectId}/journey-campaigns/${campaignId}`;
  const payload = await api.get<unknown>(
    `/projects/${projectId}/journey-campaigns/${campaignId}`,
    options,
  );
  const campaign = asRecord<JourneyCampaign>(payload, endpoint);
  if (!Array.isArray(campaign.journeys)) {
    throw shapeError(`${endpoint} (.journeys)`, 'a list of journeys', campaign.journeys);
  }
  return campaign;
}

/**
 * Create a campaign: one journey per matching **active** persona under one USD
 * cap. With `autoRun` (the server default) this plans *and executes*, so it
 * spends — the screen presents it as a budgeted run, not a form submission.
 */
export async function createJourneyCampaign(
  projectId: string,
  input: {
    name: string;
    journeyTarget: number;
    budgetUsd: number;
    surface?: JourneySurface;
    geo?: string;
    maxDepth?: number;
    maxBranches?: number;
    personaRoles?: string[];
    useLlm?: boolean;
    autoRun?: boolean;
  },
): Promise<JourneyCampaign> {
  const endpoint = `POST /projects/${projectId}/journey-campaigns`;
  return asRecord<JourneyCampaign>(
    await api.post<unknown>(`/projects/${projectId}/journey-campaigns`, input),
    endpoint,
  );
}

/** Run the remaining journeys, halting the instant cumulative spend hits the cap. */
export async function executeJourneyCampaign(
  projectId: string,
  campaignId: string,
): Promise<JourneyCampaign> {
  const endpoint = `POST /projects/${projectId}/journey-campaigns/${campaignId}/execute`;
  return asRecord<JourneyCampaign>(
    await api.post<unknown>(
      `/projects/${projectId}/journey-campaigns/${campaignId}/execute`,
    ),
    endpoint,
  );
}

/** Bare array. `active` personas are the ones a campaign can fan out over. */
export async function listPersonas(
  projectId: string,
  filter?: { status?: string },
  options?: { signal?: AbortSignal },
): Promise<Persona[]> {
  const endpoint = `GET /projects/${projectId}/personas`;
  const payload = await api.get<unknown>(`/projects/${projectId}/personas`, {
    ...options,
    query: { status: filter?.status },
  });
  return asList<Persona>(payload, endpoint);
}

// ─── Shared display helpers ──────────────────────────────────────────────

/**
 * Parses a JSON-string column the backend stores as text (`citations`,
 * `competitorsSeen`, `topDomains`, `localPackEntries`, `personaRoles`,
 * `seedInput`).
 *
 * Returns `null` — not `[]` — when the column is present but unparseable, so a
 * screen can say the field could not be read instead of rendering "none".
 */
export function parseJsonColumn<T>(raw: string | null | undefined, expected: 'array' | 'object'): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (expected === 'array') return (Array.isArray(parsed) ? parsed : null) as T | null;
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null) as T | null;
  } catch {
    return null;
  }
}

/**
 * §1.5 — how a value came to be, as a `ProvenanceKind`.
 *
 * Deliberately per-source rather than one blanket mapping: a set assembled by
 * hand and a matrix generated by a model are different kinds of claim, and the
 * badge is where that difference has to survive.
 */
export function querySetProvenance(source: string): {
  kind: 'operator-supplied' | 'model-interpretation' | 'unmeasured';
  label: string;
} {
  switch (source) {
    case 'manual':
      return { kind: 'operator-supplied', label: 'Written by hand' };
    case 'sales-questions':
      return { kind: 'operator-supplied', label: 'From sales questions' };
    case 'support-tickets':
      return { kind: 'operator-supplied', label: 'From support tickets' };
    case 'aeo-matrix':
      return { kind: 'model-interpretation', label: 'Generated matrix' };
    default:
      return { kind: 'unmeasured', label: `Provenance not recognized: ${source}` };
  }
}
