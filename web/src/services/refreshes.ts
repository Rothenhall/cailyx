import { ApiError, api } from '@/lib/api';

/**
 * Sleeper-refresh adapters — SOP-10 (CT08).
 *
 * §5.9 states the classification rule this file must not soften: *"import page
 * rows, validate URLs/metrics, classify against default ≥20% decline and ≥3
 * referring domains; **missing data is unproven**."* So the server's
 * `sleeperStatus` is three-valued — `sleeper`, `not-sleeper`, `unproven` — and
 * `unproven` is a result in its own right, not a failed classification.
 *
 * The other rule is about what a refresh proves: *"Current date movement is a
 * submitted/audited ledger signal, not proof traffic improved."* `dateModified`
 * before/after is therefore evidence that the page moved, and nothing more.
 */

export const SLEEPER_STATUSES = [
  'flagged',
  'brief-sent',
  'in-progress',
  'refreshed',
  'abandoned',
] as const;
export type SleeperStatus = (typeof SLEEPER_STATUSES)[number];

export const SLEEPER_STATUS_LABELS: Record<SleeperStatus, string> = {
  flagged: 'Flagged',
  'brief-sent': 'Brief sent',
  'in-progress': 'In progress',
  refreshed: 'Refreshed',
  abandoned: 'Abandoned',
};

/** Default thresholds. Both are operator-adjustable per read. */
export const DEFAULT_DECLINE_PCT = 20;
export const DEFAULT_MIN_REFERRING_DOMAINS = 3;

export interface SleeperPage {
  id: string;
  projectId: string;
  url: string;
  label: string | null;
  /** Positive means declined, from a GSC export or manual entry. Null is not 0. */
  trafficDeclinePct: number | null;
  referringDomains: number | null;
  status: SleeperStatus;
  /** The visible dateModified on the shipped page *before* the refresh. */
  dateModifiedBefore: string | null;
  /** The visible dateModified recorded *after* it. Audit evidence, not a traffic claim. */
  dateModifiedAfter: string | null;
  refreshedAt: string | null;
  notes: string | null;
  createdAt: string;
  /** Classification against the thresholds used for this read. */
  sleeperStatus: 'sleeper' | 'not-sleeper' | 'unproven';
}

export interface RefreshSummary {
  total: number;
  byStatus: Record<string, number>;
  refreshed: number;
  /** Refreshed pages whose recorded dateModified visibly moved. */
  dateModifiedMoved: number;
}

export interface ImportResult {
  upserted: number;
  skipped: number;
}

function asArray(payload: unknown): SleeperPage[] {
  if (Array.isArray(payload)) return payload as SleeperPage[];
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: 'Expected a list of pages but the response was not an array.',
    body: payload,
  });
}

/**
 * Candidates, sorted by decline.
 *
 * The thresholds travel with the request because the classification is
 * *relative to them*: a page is "unproven" against one pair of thresholds and
 * "not-sleeper" against another, so the screen must show which pair produced
 * the label it is displaying.
 */
export async function listSleeperPages(
  projectId: string,
  query: { minDeclinePct?: number; minReferringDomains?: number; status?: SleeperStatus } = {},
  options?: { signal?: AbortSignal },
): Promise<SleeperPage[]> {
  const payload = await api.get<unknown>(`/projects/${projectId}/sleeper-refresh/pages`, {
    ...options,
    query: {
      minDeclinePct: query.minDeclinePct,
      minReferringDomains: query.minReferringDomains,
      status: query.status,
    },
  });
  return asArray(payload);
}

export async function getRefreshSummary(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<RefreshSummary> {
  return api.get<RefreshSummary>(`/projects/${projectId}/sleeper-refresh/summary`, options);
}

/**
 * Import from a pasted GSC CSV/TSV export, or from structured rows.
 *
 * Header rows and unparseable lines are counted as `skipped` rather than
 * silently dropped, and the rows are upserted by URL inside the project. Up to
 * 500 rows per call; this route is throttled to 5/minute.
 */
export async function importSleeperPages(
  projectId: string,
  input: {
    text?: string;
    pages?: Array<{ url: string; trafficDeclinePct?: number; referringDomains?: number }>;
  },
): Promise<ImportResult> {
  return api.post<ImportResult>(`/projects/${projectId}/sleeper-refresh/import`, input);
}

/** Manual entry: one page, with what is known and nothing invented for what is not. */
export async function createSleeperPage(
  projectId: string,
  input: {
    url: string;
    label?: string;
    trafficDeclinePct?: number;
    referringDomains?: number;
    notes?: string;
  },
): Promise<SleeperPage> {
  return api.post<SleeperPage>(`/projects/${projectId}/sleeper-refresh/pages`, input);
}

export async function updateSleeperPage(
  projectId: string,
  pageId: string,
  patch: {
    status?: SleeperStatus;
    label?: string;
    trafficDeclinePct?: number;
    referringDomains?: number;
    notes?: string;
    dateModifiedBefore?: string;
  },
): Promise<SleeperPage> {
  return api.patch<SleeperPage>(
    `/projects/${projectId}/sleeper-refresh/pages/${pageId}`,
    patch,
  );
}

/**
 * Record that a refresh shipped, with the new visible dateModified.
 *
 * This is the auditable half of the SLA: it proves the page moved. It does not
 * prove traffic improved, and the screen must not imply that it does.
 */
export async function markRefreshed(
  projectId: string,
  pageId: string,
  input: { dateModifiedAfter: string; notes?: string },
): Promise<SleeperPage> {
  return api.post<SleeperPage>(
    `/projects/${projectId}/sleeper-refresh/pages/${pageId}/refreshed`,
    input,
  );
}

export async function deleteSleeperPage(projectId: string, pageId: string): Promise<SleeperPage> {
  return api.delete<SleeperPage>(`/projects/${projectId}/sleeper-refresh/pages/${pageId}`);
}
