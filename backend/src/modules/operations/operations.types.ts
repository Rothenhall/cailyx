/**
 * Response shapes for the Operations module (G14).
 *
 * @module operations.types
 */

/** Generic page envelope every list endpoint returns. Total is always computed
 * with the same `where` used to fetch `items`, so filters and totals never drift. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface OverviewDto {
  /** Scope this overview was computed under: "all" for admin, else the caller's assigned client ids. */
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

/** A single linked-evidence pointer — never the underlying row, just enough to route to it. */
export interface EvidenceLinkDto {
  type: 'report' | 'gapAnalysis' | 'scoreRun' | 'alert' | 'workItem';
  id: string;
  label: string;
}

export interface ClientHealthIssueDto {
  gapId: string;
  projectId: string;
  title: string;
  severity: string | null;
  priorityScore: number | null;
}

export interface ClientHealthDto {
  id: string;
  name: string;
  status: string;
  projectCount: number;
  /**
   * The highest `scoreTotal` among this client's projects' most recent
   * reports. NOT an aggregate client-health score — no such contract exists
   * yet. Labelled honestly so a "92" here is never read as "this client's
   * overall health is 92".
   */
  highestLatestProjectScore: number | null;
  highestLatestProjectScoreBand: string | null;
  /** Transparent reasons behind the health read — never a hidden composite number. */
  healthReasons: string[];
  worstOpenIssue: ClientHealthIssueDto | null;
  currentOpenIssueCount: number;
  overdueWorkCount: number;
  awaitingDecisionsCount: number;
  staleSourceCount: number;
  deliveryLead: { userId: string; name: string | null; email: string } | null;
  nextCommitment: { type: 'milestone' | 'work'; id: string; title: string; dueAt: string } | null;
  evidence: EvidenceLinkDto[];
}

export interface WorkRowDto {
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

export interface ReportRowDto {
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

export interface SalesLeadRowDto {
  id: string;
  email: string;
  name: string | null;
  source: string;
  status: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  createdAt: string;
}

export interface SavedViewDto {
  id: string;
  surface: string;
  name: string;
  filters: Record<string, unknown>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
