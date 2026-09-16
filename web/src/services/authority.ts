import { ApiError, api, unwrap } from '@/lib/api';
import type { ProvenanceKind } from '@/types';

/**
 * Authority adapter — AT01–AT05.
 *
 * design_plan.md §4.4 (authority block) and §5.9 ("Authority, outreach, refresh
 * and original research"). Three surfaces live here because the screens share
 * one story: a **candidate** discovered by a scan is promoted into a **mention
 * target**, which is then checked for the brand, and separately a **backlinks
 * snapshot** is pulled from a provider.
 *
 * §10.2 — envelope normalization. This module is explicit about which shape
 * each route returns, because this module is a good example of the problem the
 * rule exists for:
 *
 *  - `GET /authority-scans` and `GET /mentions/targets|/campaigns` return a
 *    **bare array**, while
 *  - `GET /backlinks` wraps its rows in `{ summaries: [...] }`.
 *
 * A bare array is checked with `expectArray` rather than trusted: an unexpected
 * body (an error envelope with a 200, a proxy's HTML, a renamed key) raises
 * instead of silently rendering as "nothing to show".
 *
 * §5.9's provenance rule is also expressed here as data rather than copy. A
 * candidate carries `discoveredVia` — that is the whole record of where it came
 * from — and `candidateProvenance` maps it onto a `ProvenanceKind` so a
 * machine-proposed candidate can never be rendered with the same badge as
 * something an operator typed in.
 */

/* ────────────────────────────── vocabulary ───────────────────────────── */

export type AuthorityMethod = 'serp' | 'llm' | 'citations' | 'combined';

export const AUTHORITY_METHODS: readonly AuthorityMethod[] = [
  'serp',
  'llm',
  'citations',
  'combined',
];

export const AUTHORITY_METHOD_LABEL: Record<AuthorityMethod, string> = {
  serp: 'Search results (SERP)',
  llm: 'Model-suggested',
  citations: 'AI-answer citations',
  combined: 'Combined',
};

/** What each method actually reads. Shown next to the choice, per §10.4. */
export const AUTHORITY_METHOD_DESCRIPTION: Record<AuthorityMethod, string> = {
  serp: 'Reads live search results for the listicle queries. Needs the SERP provider configured and live calls enabled.',
  llm: 'Asks a model where this kind of brand could earn a mention. Needs an LLM provider key; results are model suggestions, not measured data.',
  citations: 'Reads the AI answers this project has already collected and lists the domains they cite. Needs existing journey or measurement data.',
  combined: 'Runs every available source and merges the candidates. Sources that are unavailable are reported as failed parts of the scan.',
};

export type AuthorityScanStatus = 'running' | 'complete' | 'partial' | 'failed';

export type AuthorityCandidateStatus = 'new' | 'promoted' | 'dismissed';

export type AuthorityCandidateType =
  | 'listicle'
  | 'community'
  | 'podcast'
  | 'publication'
  | 'directory'
  | 'newsletter';

/** An authority discovery scan (prisma `AuthorityScan`). */
export interface AuthorityScan {
  id: string;
  projectId: string;
  category: string;
  method: string;
  status: string;
  /** A JSON **string** on the wire, e.g. `'["best ai tools"]'`. Use
   *  `parseListicleQueries` — do not render this raw. */
  listicleQueries: string;
  candidateCount: number;
  promotedCount: number;
  costUsd: number;
  /** The LLM model id when model discovery ran; null otherwise. */
  model: string | null;
  /** Set on a partial scan, e.g. "one or more discovery sources failed". */
  note: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** One discovered candidate. */
export interface AuthorityCandidate {
  id: string;
  scanId: string;
  projectId: string;
  domain: string;
  url: string;
  title: string;
  type: string;
  /**
   * How this candidate was found — `'serp:<keyword>'`, `'llm'`,
   * `'citation:journey'` or `'citation:measurement'`. This is the candidate's
   * only provenance record, and the reason a candidate must not be presented
   * as a confirmed target.
   */
  discoveredVia: string;
  /** SERP position when it came from a result page; null for model/citation finds. */
  rank: number | null;
  /** 0–1 relevance as scored by the scan. */
  relevance: number;
  rationale: string;
  status: string;
  /** The mention target this became, once promoted. */
  promotedTargetId: string | null;
  createdAt: string;
}

export interface AuthorityScanDetail extends AuthorityScan {
  /** Ordered by relevance descending, then domain. */
  candidates: AuthorityCandidate[];
}

/** `POST …/promote` — creates a mention target; nothing is contacted (§5.9). */
export interface AuthorityPromoteResult {
  candidate: AuthorityCandidate;
  target: MentionTarget;
}

/* ──────────────────────────── mention tracking ───────────────────────── */

export type MentionTargetType = 'listicle' | 'community' | 'review' | 'other';

export const MENTION_TARGET_TYPES: readonly MentionTargetType[] = [
  'listicle',
  'community',
  'review',
  'other',
];

export type MentionTargetStatus = 'new' | 'contacted' | 'replied' | 'placed' | 'rejected';

/** The outreach pipeline, in the order §5.9 describes it. */
export const MENTION_TARGET_STATUSES: readonly MentionTargetStatus[] = [
  'new',
  'contacted',
  'replied',
  'placed',
  'rejected',
];

export const MENTION_TARGET_STATUS_LABEL: Record<MentionTargetStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  replied: 'Replied',
  placed: 'Placed',
  rejected: 'Rejected',
};

/** A recorded outreach target (prisma `MentionTarget`). */
export interface MentionTarget {
  id: string;
  projectId: string;
  url: string;
  type: string;
  label: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  campaignId: string | null;
}

/**
 * One semi-auto check of a target page.
 *
 * `mentioned` is the finding; `httpStatus` is how the page answered. They are
 * separate facts on purpose — a check that could not fetch the page returns
 * `mentioned: false` with `httpStatus: null`, which is **not** the same
 * evidence as a page that answered 200 without the brand on it.
 */
export interface MentionCheck {
  id: string;
  targetId: string;
  checkedAt: string;
  mentioned: boolean;
  /** The ±60-character excerpt around the match; null when nothing matched. */
  evidence: string | null;
  fetchedTitle: string | null;
  /** Null when the fetch itself failed. */
  httpStatus: number | null;
}

/**
 * A target with its newest check.
 *
 * `latestCheck === null` means **this target has never been checked** — it is
 * not a target that was checked and not found. AT04 exists to keep those two
 * apart.
 */
export interface MentionTargetWithLatestCheck extends MentionTarget {
  latestCheck: MentionCheck | null;
  /**
   * True when the backend returned no `latestCheck` key at all.
   *
   * The backend sets `checks: undefined` before serializing, so the key is
   * absent rather than null. Both mean "no check has been recorded", but the
   * distinction is kept so a future shape change is visible rather than
   * silently read as "no check".
   */
  latestCheckKeyAbsent?: boolean;
}

export interface MentionCampaign {
  id: string;
  projectId: string;
  name: string;
  /** The "best X" hunt query this campaign is anchored to. */
  listicleQuery: string | null;
  createdAt: string;
}

/** `GET /mentions/campaigns` — the count is nested, not a `targetCount` field. */
export interface MentionCampaignWithCount extends MentionCampaign {
  _count: { targets: number };
}

/**
 * One row of the decay view (`GET /mentions/decay`).
 *
 * §3.5 / §5.9: the three states this row must be read as are
 *  - `lastCheckedAt === null` → **never checked** (nothing is known),
 *  - `everMentioned === true` → a mention was found; `daysSinceLastMention`
 *    ages it,
 *  - `everMentioned === false && lastCheckedAt !== null` → **checked and
 *    absent**.
 *
 * `stale` is only ever true in the second state. A `stale: false` on a
 * never-checked target is therefore not reassurance, and must not be rendered
 * as one. `staleDays` carries the threshold so the screen can state it.
 */
export interface MentionDecayRow {
  /** The target id. This row carries no other target field — no label, no notes. */
  targetId: string;
  url: string;
  type: string;
  status: string;
  everMentioned: boolean;
  lastMentionedAt: string | null;
  lastCheckedAt: string | null;
  daysSinceLastMention: number | null;
  /** True when `daysSinceLastMention >= 90`. */
  stale: boolean;
}

/** The threshold the backend applies when it sets `stale` (SOP-7). */
export const MENTION_DECAY_DAYS = 90;

/* ─────────────────────────────── backlinks ───────────────────────────── */

export type BacklinksStatus = 'pending' | 'completed' | 'partial' | 'failed';

/** One row of the provider's top-backlink sample. */
export interface BacklinkSample {
  /** Empty string (not null) when the provider omitted it. */
  urlFrom: string;
  urlTo: string;
  anchor: string | null;
  dofollow: boolean;
  rank: number | null;
  domainFromRank: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  itemType: string | null;
}

/**
 * One backlinks snapshot from the provider.
 *
 * The counts are **flat on the row** — there is no `counts` object. Every
 * count is nullable, and null means the provider did not return it: §6.3's
 * "If observations=0, render 'Not measured'" applies to each one separately.
 *
 * `topBacklinks` is a *sample* ranked by authority, not an inventory. §6.3:
 * "Provider snapshot with sample of top links … sample is not full inventory."
 */
export interface BacklinksSummary {
  id: string;
  projectId: string;
  /** Normalized query target (scheme and trailing slashes stripped). */
  target: string;
  status: string;
  /** The only failure detail besides `status`. */
  error: string | null;
  costUsd: number;

  rank: number | null;
  backlinks: number | null;
  backlinksSpamScore: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  referringPages: number | null;
  referringIps: number | null;
  referringSubnets: number | null;
  brokenBacklinks: number | null;
  brokenPages: number | null;

  firstSeen: string | null;
  lostDate: string | null;

  referringLinksTld: Record<string, number> | null;
  referringLinksTypes: Record<string, number> | null;
  referringLinksAttributes: Record<string, number> | null;
  referringLinksPlatformTypes: Record<string, number> | null;
  referringLinksCountries: Record<string, number> | null;

  topBacklinks: BacklinkSample[];
  createdAt: string;
}

/* ──────────────────────────── normalization ──────────────────────────── */

/**
 * Reads a body that this API documents as a bare array.
 *
 * §10.2: "do not read an unexpected shape as no data". `unwrap` covers the
 * wrapped routes; this covers the unwrapped ones, so a response that is not an
 * array raises instead of rendering an empty list.
 */
function expectArray<T>(payload: unknown, what: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: `The server did not return ${what} as a list.`,
    body: payload,
  });
}

/**
 * Parses `AuthorityScan.listicleQueries`.
 *
 * The column is a JSON string. Returns `null` — never `[]` — when it cannot be
 * read as a string array, so a malformed value is reported as unreadable
 * rather than shown as "no queries were used".
 */
export function parseListicleQueries(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const strings = parsed.filter((entry): entry is string => typeof entry === 'string');
    return strings.length === parsed.length ? strings : null;
  } catch {
    return null;
  }
}

/**
 * How a candidate was discovered, as a provenance class.
 *
 * §5.9 and the AT01 contract: a discovery candidate is **not** a confirmed
 * target, so this never returns `measured` or `operator-supplied` — there is no
 * input that would make a discovered candidate either of those. An
 * unrecognized source is `unmeasured`, because "we do not know where this came
 * from" is not a measurement.
 */
export function candidateProvenance(discoveredVia: string | null | undefined): {
  kind: ProvenanceKind;
  label?: string;
} {
  const source = (discoveredVia ?? '').trim().toLowerCase();
  if (source.startsWith('serp')) return { kind: 'discovered-candidate' };
  if (source === 'llm' || source.startsWith('llm')) {
    return { kind: 'model-interpretation', label: 'Model interpretation' };
  }
  if (source.startsWith('citation')) {
    return { kind: 'derived', label: 'Derived from AI answers' };
  }
  return { kind: 'unmeasured', label: 'Discovery source not recorded' };
}

/** The three mention states AT04 must keep apart. */
export type MentionState = 'never-checked' | 'ever-mentioned' | 'checked-absent';

export function mentionState(row: {
  everMentioned: boolean;
  lastCheckedAt: string | null;
}): MentionState {
  if (row.everMentioned) return 'ever-mentioned';
  return row.lastCheckedAt === null ? 'never-checked' : 'checked-absent';
}

/* ─────────────────────────────── authority ───────────────────────────── */

const scansPath = (projectId: string) => `/projects/${projectId}/authority-scans`;

/** `GET /authority-scans` — a **bare array**, newest first. */
export async function listAuthorityScans(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<AuthorityScan[]> {
  const payload = await api.get<unknown>(scansPath(projectId), options);
  return expectArray<AuthorityScan>(payload, 'the authority scans');
}

/** `GET /authority-scans/:scanId` — the scan with its ranked candidates. */
export async function getAuthorityScan(
  projectId: string,
  scanId: string,
  options?: { signal?: AbortSignal },
): Promise<AuthorityScanDetail> {
  return api.get<AuthorityScanDetail>(`${scansPath(projectId)}/${scanId}`, options);
}

export interface RunAuthorityScanInput {
  category?: string;
  method?: AuthorityMethod;
  listicleQueries?: string[];
  useLlm?: boolean;
}

/**
 * `POST /authority-scans` — runs a discovery scan.
 *
 * This is a **synchronous and potentially slow** call: it performs the provider
 * lookups before responding, and the LLM method can take minutes. Callers must
 * drive it from an explicit start action (§10.4) and must not abort it — an
 * abandoned request does not stop the scan server-side, so an abort would leave
 * a scan running with the operator told it failed.
 */
export async function runAuthorityScan(
  projectId: string,
  input: RunAuthorityScanInput,
): Promise<AuthorityScanDetail> {
  return api.post<AuthorityScanDetail>(scansPath(projectId), input);
}

/** `PATCH …/candidates/:candidateId` — sets `new` | `promoted` | `dismissed`. */
export async function updateAuthorityCandidate(
  projectId: string,
  scanId: string,
  candidateId: string,
  status: AuthorityCandidateStatus,
): Promise<AuthorityCandidate> {
  return api.patch<AuthorityCandidate>(
    `${scansPath(projectId)}/${scanId}/candidates/${candidateId}`,
    { status },
  );
}

/**
 * `POST …/candidates/:candidateId/promote` — creates a mention target.
 *
 * §5.9: "Promotion creates a ledger record, not an email." A 409 means the
 * candidate was already promoted; the existing target id is on the candidate.
 */
export async function promoteAuthorityCandidate(
  projectId: string,
  scanId: string,
  candidateId: string,
): Promise<AuthorityPromoteResult> {
  return api.post<AuthorityPromoteResult>(
    `${scansPath(projectId)}/${scanId}/candidates/${candidateId}/promote`,
  );
}

/** `DELETE /authority-scans/:scanId` — returns `{ removed: <scanId> }`. */
export async function deleteAuthorityScan(projectId: string, scanId: string) {
  return api.delete<{ removed: string }>(`${scansPath(projectId)}/${scanId}`);
}

/* ──────────────────────────── mention tracking ───────────────────────── */

const mentionsPath = (projectId: string) => `/projects/${projectId}/mentions`;

/** `GET /mentions/campaigns` — a **bare array**, newest first. */
export async function listMentionCampaigns(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<MentionCampaignWithCount[]> {
  const payload = await api.get<unknown>(`${mentionsPath(projectId)}/campaigns`, options);
  return expectArray<MentionCampaignWithCount>(payload, 'the outreach campaigns');
}

/**
 * `POST /mentions/campaigns` — creates a campaign.
 *
 * Returns the bare campaign row: no `_count`, so a created campaign's target
 * count comes from the list, not from this response.
 */
export async function createMentionCampaign(
  projectId: string,
  input: { name: string; listicleQuery?: string },
): Promise<MentionCampaign> {
  return api.post<MentionCampaign>(`${mentionsPath(projectId)}/campaigns`, input);
}

/**
 * `GET /mentions/targets` — a **bare array**, newest first.
 *
 * Each row carries `latestCheck`, which is `null` until the target is checked
 * for the first time.
 */
export async function listMentionTargets(
  projectId: string,
  filter?: { status?: MentionTargetStatus },
  options?: { signal?: AbortSignal },
): Promise<MentionTargetWithLatestCheck[]> {
  const payload = await api.get<unknown>(`${mentionsPath(projectId)}/targets`, {
    ...options,
    query: { status: filter?.status },
  });
  const rows = expectArray<MentionTargetWithLatestCheck>(payload, 'the mention targets');
  return rows.map((row) => ({
    ...row,
    latestCheck: row.latestCheck ?? null,
    latestCheckKeyAbsent: !('latestCheck' in row) || row.latestCheck === undefined,
  }));
}

export interface CreateMentionTargetInput {
  url: string;
  type?: MentionTargetType;
  label?: string;
  campaignId?: string;
  notes?: string;
}

/** `POST /mentions/targets` — records a target by hand. No check is run. */
export async function createMentionTarget(
  projectId: string,
  input: CreateMentionTargetInput,
): Promise<MentionTarget> {
  return api.post<MentionTarget>(`${mentionsPath(projectId)}/targets`, input);
}

/** `PATCH /mentions/targets/:targetId` — label, status or notes. */
export async function updateMentionTarget(
  projectId: string,
  targetId: string,
  patch: { label?: string; status?: MentionTargetStatus; notes?: string },
): Promise<MentionTarget> {
  return api.patch<MentionTarget>(`${mentionsPath(projectId)}/targets/${targetId}`, patch);
}

/** `DELETE /mentions/targets/:targetId` — checks cascade. */
export async function deleteMentionTarget(projectId: string, targetId: string) {
  return api.delete<{ deleted: boolean }>(`${mentionsPath(projectId)}/targets/${targetId}`);
}

/**
 * `POST /mentions/targets/:targetId/check` — one semi-auto check.
 *
 * Fetches the target page once and records whether the brand token appears.
 * The brand token is a required input, not a stored setting: the check is only
 * meaningful for a token the caller states, so the screen asks for it rather
 * than guessing the project's brand.
 *
 * A fetch failure is recorded as `mentioned: false` with `httpStatus: null` —
 * the caller must not read that as "the mention was lost".
 */
export async function checkMentionTarget(
  projectId: string,
  targetId: string,
  brandToken: string,
): Promise<MentionCheck> {
  return api.post<MentionCheck>(`${mentionsPath(projectId)}/targets/${targetId}/check`, {
    brandToken,
  });
}

/** `GET /mentions/targets/:targetId/checks` — a **bare array**, newest first. */
export async function listMentionChecks(
  projectId: string,
  targetId: string,
  options?: { signal?: AbortSignal },
): Promise<MentionCheck[]> {
  const payload = await api.get<unknown>(
    `${mentionsPath(projectId)}/targets/${targetId}/checks`,
    options,
  );
  return expectArray<MentionCheck>(payload, 'the check history');
}

/**
 * `GET /mentions/decay?brandToken=` — a **bare array**, in no guaranteed order.
 *
 * The brand token is required by the route, so a caller without one cannot
 * ask for this view at all. The screen states that prerequisite rather than
 * requesting it and rendering an empty list.
 */
export async function getMentionDecay(
  projectId: string,
  brandToken: string,
  options?: { signal?: AbortSignal },
): Promise<MentionDecayRow[]> {
  const payload = await api.get<unknown>(`${mentionsPath(projectId)}/decay`, {
    ...options,
    query: { brandToken },
  });
  return expectArray<MentionDecayRow>(payload, 'the decay rows');
}

/* ─────────────────────────────── backlinks ───────────────────────────── */

export interface RefreshBacklinksInput {
  /** Defaults to the project's own domain server-side. */
  target?: string;
  /** 0–100, default 10. 0 skips the sample entirely. */
  sampleLimit?: number;
}

/**
 * `POST /backlinks/refresh` — pulls a new snapshot.
 *
 * A paid, provider-backed action: the response is a snapshot whose `status` may
 * be `'partial'` or `'failed'` and still be a 201. Callers must read `status`,
 * not the status code. Requires live calls to be enabled and provider
 * credentials; otherwise the server answers 503 naming what is missing.
 */
export async function refreshBacklinks(
  projectId: string,
  input: RefreshBacklinksInput = {},
): Promise<BacklinksSummary> {
  return api.post<BacklinksSummary>(`/projects/${projectId}/backlinks/refresh`, input);
}

/** `GET /backlinks` — wrapped in `{ summaries: [...] }`, newest first. */
export async function listBacklinksSummaries(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<BacklinksSummary[]> {
  const payload = await api.get<{ summaries: BacklinksSummary[] }>(
    `/projects/${projectId}/backlinks`,
    options,
  );
  return unwrap<BacklinksSummary[]>(payload, 'summaries');
}

/**
 * `GET /backlinks/latest` — the newest snapshot, or none.
 *
 * When no snapshot exists the backend responds **200 with an empty body**, not
 * a JSON `null` (Nest sends nothing for a null body). The adapter converts both
 * to `null`, because that is the route's documented "no snapshot yet" answer —
 * this is a case where an absent body is the contract rather than an
 * unexpected shape.
 */
export async function getLatestBacklinksSummary(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<BacklinksSummary | null> {
  const payload = await api.get<BacklinksSummary | null | undefined>(
    `/projects/${projectId}/backlinks/latest`,
    options,
  );
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object') {
    throw new ApiError({
      kind: 'unknown',
      status: 0,
      message: 'The server did not return a backlinks snapshot.',
      body: payload,
    });
  }
  return payload;
}

/**
 * Whether two snapshots may have their difference presented as a change.
 *
 * §6.4 / G13: a comparison needs a comparison key — project/domain, query
 * period, provider method and sample policy. The snapshot row records **none of
 * those beyond `target`**, so two pulls a week apart cannot be told apart from
 * two pulls with different sample limits or a provider-side change in
 * inventory. AT05 therefore reports a methodology break and withholds the
 * delta, naming what is missing, rather than drawing an improvement arrow from
 * two numbers that happen to be adjacent.
 *
 * The one thing that *is* recorded is `target`; when it differs, the two rows
 * describe different things and say so specifically.
 */
export function backlinksComparisonKey(
  before: BacklinksSummary,
  after: BacklinksSummary,
): { comparable: false; reason: string } {
  if (before.target !== after.target) {
    return {
      comparable: false,
      reason: `These snapshots were pulled for different targets — "${before.target}" and "${after.target}" — so they do not describe the same thing.`,
    };
  }
  return {
    comparable: false,
    reason:
      'A backlinks snapshot records its target and its creation time, but not the query period, the sample size or the provider method that produced it. Because the comparison key is not recorded, the difference between two pulls cannot be attributed to a change in the site rather than to the sample or the provider.',
  };
}
