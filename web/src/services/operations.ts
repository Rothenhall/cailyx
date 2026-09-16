import { api } from '@/lib/api';

/**
 * Portfolio aggregation adapter (G14) — design_plan.md screens OP01, OP02,
 * OP10, OP14 and SL02.
 *
 * These endpoints are **server-aggregated**. That is the whole point of G14:
 * a portfolio of 200 clients must load in one query rather than a fan-out of
 * per-client requests, because the global limit is 100 requests/minute/IP and
 * an office shares one IP (§10.3).
 *
 * Consequently the functions here take only filters, never a list of ids to
 * loop over. If a caller finds itself wanting to call one of these once per
 * client, the endpoint is wrong and should be extended instead.
 *
 * Every row type below mirrors `backend/src/modules/operations/operations.types.ts`.
 * Where that file carries a warning in a comment — for example that
 * `highestLatestProjectScore` is NOT an aggregate health score — the warning is
 * repeated here so a screen author reads it at the point of use.
 */

/**
 * A page of results. Mirrors the backend's own `Page<T>`
 * (`operations.types.ts`).
 *
 * This is **page-based, not cursor-based**, and the distinction is not
 * cosmetic: `PortfolioListQueryDto` whitelists `page` and `pageSize` and the
 * global pipe runs `forbidNonWhitelisted`, so sending `cursor` or `limit`
 * is rejected with a 400 rather than ignored. An earlier version of this file
 * declared a cursor and did exactly that.
 */
export interface Page<T> {
  items: T[];
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Total matching rows server-side, independent of `items.length`. */
  total: number;
}

export interface OperationsOverview {
  /** "all" for admin; "assigned" when scoped to the caller's assignments. */
  scope: 'all' | 'assigned';
  assignedClientCount: number | null;
  clients: { total: number; active: number; paused: number; churned: number };
  projects: { total: number; byStatus: Record<string, number> };
  work: { open: number; overdue: number; blocked: number; awaitingReview: number };
  approvals: { pending: number };
  reports: { total: number; byStatus: Record<string, number> };
  leads: { total: number; byStatus: Record<string, number> };
  alerts: { critical: number; warning: number; info: number };
  staleSources: number;
}

export interface ClientHealthIssue {
  id: string;
  title: string;
  severity: string;
  projectId: string;
  projectName: string;
}

export interface EvidenceLink {
  label: string;
  href: string;
  /** ISO 8601. */
  capturedAt?: string;
}

export interface ClientHealthRow {
  id: string;
  name: string;
  status: string;
  projectCount: number;
  /**
   * ⚠️ The highest `scoreTotal` among this client's most recent project
   * reports. This is **not** an aggregate client-health score — no such
   * contract exists yet (design_plan G14, line 1683). Render it with that
   * label or not at all.
   */
  highestLatestProjectScore: number | null;
  highestLatestProjectScoreBand: string | null;
  /** Transparent reasons behind the health read — never a hidden composite. */
  healthReasons: string[];
  worstOpenIssue: ClientHealthIssue | null;
  currentOpenIssueCount: number;
  overdueWorkCount: number;
  awaitingDecisionsCount: number;
  staleSourceCount: number;
  deliveryLead: { userId: string; name: string | null; email: string } | null;
  nextCommitment: { type: 'milestone' | 'work'; id: string; title: string; dueAt: string } | null;
  evidence: EvidenceLink[];
}

export interface WorkRow {
  id: string;
  title: string;
  status: string;
  category: string;
  discipline: string;
  priority: string;
  assigneeId: string | null;
  dueAt: string | null;
  overdue: boolean;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
}

export interface ReportRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  visibility: string;
  scoreTotal: number;
  scoreBand: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface SalesLeadRow {
  id: string;
  email: string;
  name: string | null;
  source: string;
  status: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
}

export interface SavedView {
  id: string;
  surface: string;
  name: string;
  filters: Record<string, unknown>;
  isDefault: boolean;
}

/**
 * The shared list contract: `page`/`pageSize` plus filters.
 *
 * `pageSize` is capped server-side (max 100), so a caller asking for more is
 * clamped rather than rejected — but the response's own `pageSize` is what a
 * screen should display, never the number it asked for.
 */
export type PaginatedQuery = {
  /** 1-based page number. Defaults to 1 server-side. */
  page?: number;
  /** Rows per page. Server default 25, maximum 100. */
  pageSize?: number;
  search?: string;
  [key: string]: string | number | boolean | undefined;
};

export async function getOverview(options?: { signal?: AbortSignal }) {
  return api.get<OperationsOverview>('/operations/overview', options);
}

export async function getClientsHealth(query: PaginatedQuery, options?: { signal?: AbortSignal }) {
  return api.get<Page<ClientHealthRow>>('/operations/clients/health', { ...options, query });
}

export async function getWork(query: PaginatedQuery, options?: { signal?: AbortSignal }) {
  return api.get<Page<WorkRow>>('/operations/work', { ...options, query });
}

export async function getReportCenter(query: PaginatedQuery, options?: { signal?: AbortSignal }) {
  return api.get<Page<ReportRow>>('/operations/reports', { ...options, query });
}

export async function getSalesLeads(query: PaginatedQuery, options?: { signal?: AbortSignal }) {
  return api.get<Page<SalesLeadRow>>('/operations/sales/leads', { ...options, query });
}

export async function listSavedViews(surface?: string, options?: { signal?: AbortSignal }) {
  return api.get<{ views: SavedView[] }>('/saved-views', { ...options, query: { surface } });
}

/**
 * Saved views store the **filter query**, never a cached copy of the rows it
 * returned — a saved view must not become a stale shadow of client data.
 */
export async function createSavedView(input: {
  surface: string;
  name: string;
  filters: Record<string, unknown>;
  isDefault?: boolean;
}) {
  return api.post<SavedView>('/saved-views', input);
}

export async function deleteSavedView(id: string) {
  return api.delete<{ id: string; deleted: true }>(`/saved-views/${id}`);
}
