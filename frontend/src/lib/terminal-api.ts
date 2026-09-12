/**
 * Typed API helpers for the Cailyx operator dashboard.
 *
 * @module lib/terminal-api
 */

import { apiFetch } from './api';
import type { User } from '@/types/api';
import type {
  AeoAudit,
  AeoBudget,
  ReportSummary,
  ScorecardRun,
  KeywordSet,
  CompetitorGap,
  CompetitorRow,
  TechStackScan,
  AeoAuditSummary,
  AeoContext,
  AeoMatrix,
  AeoVerdict,
  AgentsResponse,
  AnalyticsSummary,
  AuditComparison,
  AuditTrendPoint,
  GoogleConnectionView,
  GoogleResourcesView,
  GoogleService,
  IntegrationsResponse,
  JobStatus,
  LinkGraph,
  PresenceAccount,
  PresenceInventory,
  PresenceRun,
  ProjectDetail,
  SafeUser,
  SearchConsoleSummary,
  SeoAudit,
  SeoAuditSummary,
  SeoComparison,
  SeoTrendPoint,
  TechnicalAudit,
} from '@/types/terminal';

export const getMe = () => apiFetch<User>('/auth/me');

export const listProjects = () =>
  apiFetch<{ projects: ProjectDetail[] }>('/projects').then((r) => r.projects);

export const getProject = (id: string) => apiFetch<ProjectDetail>(`/projects/${id}`);

export const patchProject = (id: string, patch: Partial<Pick<ProjectDetail, 'name' | 'category' | 'clientName' | 'notes'>>) =>
  apiFetch<ProjectDetail>(`/projects/${id}`, { method: 'PATCH', json: patch });

export const createProject = (json: { name: string; domain: string; category?: string }) =>
  apiFetch<ProjectDetail>('/projects', { method: 'POST', json });

export const getAgents = (projectId: string) =>
  apiFetch<AgentsResponse>(`/projects/${projectId}/agents`);

export const getIntegrations = () => apiFetch<IntegrationsResponse>('/integrations');

/* ── Google (Search Console + Analytics) OAuth ──────────────────────────── */

/** Whether the server has the OAuth client id/secret configured. */
export const getGoogleStatus = () =>
  apiFetch<{ configured: boolean }>('/integrations/google/status');

/** Start the consent flow — returns the Google URL to open in a popup. */
export const authorizeGoogle = (service: GoogleService, projectId?: string) =>
  apiFetch<{ url: string }>('/integrations/google/authorize', {
    method: 'POST',
    json: { service, ...(projectId ? { projectId } : {}) },
  });

export const listGoogleConnections = () =>
  apiFetch<GoogleConnectionView[]>('/integrations/google/connections');

export const disconnectGoogle = (service: GoogleService) =>
  apiFetch<{ ok: true }>(`/integrations/google/connections/${service}`, { method: 'DELETE' });

/** Sites (GSC) or GA4 properties the connected account can read + current map. */
export const getGoogleResources = (service: GoogleService, projectId: string) =>
  apiFetch<GoogleResourcesView>(
    `/integrations/google/resources?service=${service}&projectId=${encodeURIComponent(projectId)}`,
  );

export const setGoogleResource = (input: {
  service: GoogleService;
  projectId: string;
  resourceId: string;
  resourceLabel?: string;
}) =>
  apiFetch<{ ok: true }>('/integrations/google/resources', { method: 'PUT', json: input });

export const getSearchConsoleSummary = (projectId: string, days = 28) =>
  apiFetch<SearchConsoleSummary>(
    `/integrations/google/search-console/summary?projectId=${encodeURIComponent(projectId)}&days=${days}`,
  );

export const getAnalyticsSummary = (projectId: string, days = 28) =>
  apiFetch<AnalyticsSummary>(
    `/integrations/google/analytics/summary?projectId=${encodeURIComponent(projectId)}&days=${days}`,
  );

/* ── SEO audit ──────────────────────────────────────────────────────────── */

export const listSeoAudits = (projectId: string) =>
  apiFetch<{ audits: SeoAuditSummary[] }>(`/projects/${projectId}/seo-audit`).then((r) => r.audits);

export const getSeoAudit = (projectId: string, auditId: string) =>
  apiFetch<SeoAudit>(`/projects/${projectId}/seo-audit/${auditId}`);

/** Queues the audit on the background pipeline; returns immediately with a jobId. */
export const runSeoAudit = (projectId: string, windowDays = 28) =>
  apiFetch<{ jobId: string; projectId: string; status: string }>(
    `/projects/${projectId}/seo-audit/run`,
    { method: 'POST', json: { windowDays } },
  );

export const getSeoAuditJob = (projectId: string, jobId: string) =>
  apiFetch<JobStatus<SeoAudit>>(`/projects/${projectId}/seo-audit/run/jobs/${jobId}`);

export const getSeoComparison = (projectId: string, auditId: string) =>
  apiFetch<SeoComparison>(`/projects/${projectId}/seo-audit/${auditId}/comparison`);

export const getSeoTrend = (projectId: string, limit = 30) =>
  apiFetch<{ history: SeoTrendPoint[] }>(
    `/projects/${projectId}/seo-audit/trend/history?limit=${limit}`,
  ).then((r) => r.history);

export const submitSeoSitemaps = (projectId: string) =>
  apiFetch<{ submitted: string[] }>(`/projects/${projectId}/seo-audit/submit-sitemaps`, { method: 'POST' });

export const getSeoSchedule = (projectId: string) =>
  apiFetch<AuditSchedule>(`/projects/${projectId}/seo-audit/schedule`);

export const setSeoSchedule = (projectId: string, cadence: AuditCadence) =>
  apiFetch<AuditSchedule>(`/projects/${projectId}/seo-audit/schedule`, { method: 'PUT', json: { cadence } });

export const listAudits = (projectId: string) =>
  apiFetch<{
    audits: Array<{
      id: string;
      createdAt: string;
      targetUrl: string;
      score: number | null;
      pagesCrawled: number;
      previousAuditId: string | null;
      narrative: string | null;
      findings: unknown[];
    }>;
  }>(`/projects/${projectId}/technical-audit`).then((r) => r.audits);

export const getAudit = (projectId: string, auditId: string) =>
  apiFetch<TechnicalAudit>(`/projects/${projectId}/technical-audit/${auditId}`);

/**
 * Queue an audit on the background pipeline. `targetUrl` is optional —
 * omitted, the backend audits the project's own domain, which is what the
 * console wants: the operator should never retype their own URL. Returns
 * immediately with a jobId — poll `getAuditJob` for status/result.
 */
export const runAudit = (projectId: string, targetUrl?: string, pageBudget?: number) =>
  apiFetch<{ jobId: string; projectId: string; targetUrl: string; status: string }>(
    `/projects/${projectId}/technical-audit/run`,
    {
      method: 'POST',
      json: {
        ...(targetUrl ? { targetUrl } : {}),
        ...(pageBudget ? { pageBudget } : {}),
      },
    },
  );

export const getAuditJob = (projectId: string, jobId: string) =>
  apiFetch<JobStatus<TechnicalAudit>>(`/projects/${projectId}/technical-audit/run/jobs/${jobId}`);

/** Previous-vs-current comparison for one run. */
export const getAuditComparison = (projectId: string, auditId: string) =>
  apiFetch<AuditComparison>(`/projects/${projectId}/technical-audit/${auditId}/comparison`);

/** Score history, oldest first. */
export const getAuditTrend = (projectId: string, limit = 30) =>
  apiFetch<{ history: AuditTrendPoint[] }>(
    `/projects/${projectId}/technical-audit/trend/history?limit=${limit}`,
  ).then((r) => r.history);

export type AuditCadence = 'daily' | 'weekly' | 'monthly' | 'manual-only';

export interface AuditSchedule {
  cadence: AuditCadence;
  nextRunAt: string | null;
  active: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

/** Current recurring-audit schedule for a project. */
export const getAuditSchedule = (projectId: string) =>
  apiFetch<AuditSchedule>(`/projects/${projectId}/technical-audit/schedule`);

/** Set the recurring-audit cadence. `manual-only` turns monitoring off. */
export const setAuditSchedule = (projectId: string, cadence: AuditCadence) =>
  apiFetch<AuditSchedule>(`/projects/${projectId}/technical-audit/schedule`, {
    method: 'PUT',
    json: { cadence },
  });

export const listLinkGraphs = (projectId: string) =>
  apiFetch<LinkGraph[]>(`/projects/${projectId}/link-graph`);

export const getMeasurementSummary = (projectId: string) =>
  apiFetch<{
    runs: number;
    observations: number;
    mentionRate: number;
    citationRate: number;
    shareOfVoice: Array<{ name: string; share: number }>;
  }>(`/projects/${projectId}/measurement/summary`);

/* ── user administration (admin only) ─────────────────────────── */
export const listUsers = () => apiFetch<{ users: SafeUser[] }>('/users').then((r) => r.users);
export const getUserRoles = () => apiFetch<{ roles: string[] }>('/users/roles').then((r) => r.roles);
export const createUser = (json: { email: string; password: string; name: string; role: string }) =>
  apiFetch<SafeUser>('/users', { method: 'POST', json });
export const updateUser = (id: string, json: { name?: string; role?: string }) =>
  apiFetch<SafeUser>(`/users/${id}`, { method: 'PATCH', json });
export const resetUserPassword = (id: string, password: string) =>
  apiFetch<{ id: string; sessionsRevoked: number }>(`/users/${id}/password`, { method: 'POST', json: { password } });
export const deleteUser = (id: string) =>
  apiFetch<{ removed: string }>(`/users/${id}`, { method: 'DELETE' });

/* ── flywheel / suggestions ───────────────────────────────────── */
export const getSuggestions = (projectId: string) =>
  apiFetch<import('@/components/terminal/Flywheel').SuggestionWheel>(
    `/projects/${projectId}/journeys/suggestions`,
  );

/* ── agent runs (v2 write path) ───────────────────────────────────────────
   Every one of these is deterministic by default: `useLlm` is left unset and
   live surfaces stay behind SWARM_ALLOW_LIVE, so nothing here spends money
   unless the operator has explicitly configured it server-side. */

export interface QuerySet {
  id: string;
  version: number;
  persona: string;
  label: string | null;
  status: string;
  items: Array<{ id: string; prompt: string; funnelStage: string }>;
}

export const listQuerySets = (projectId: string) =>
  apiFetch<QuerySet[]>(`/projects/${projectId}/query-sets`);

export const generatePersonas = (projectId: string, json: { count: number; roles?: string[] }) =>
  apiFetch<unknown>(`/projects/${projectId}/personas/generate`, { method: 'POST', json });

export const generateFindings = (projectId: string, json: { limit?: number } = {}) =>
  apiFetch<unknown>(`/projects/${projectId}/findings/generate`, { method: 'POST', json });

export const runAuthorityScan = (projectId: string, json: { category?: string } = {}) =>
  apiFetch<unknown>(`/projects/${projectId}/authority-scans`, { method: 'POST', json });

export const runCouncil = (projectId: string, json: { question?: string; rounds?: number } = {}) =>
  apiFetch<unknown>(`/projects/${projectId}/council`, { method: 'POST', json });

export const runMonitoringCheck = (projectId: string) =>
  apiFetch<unknown>(`/projects/${projectId}/monitoring/check`, { method: 'POST' });

export const createMeasurementRun = (
  projectId: string,
  json: { querySetId: string; surface: string; runCount?: number },
) => apiFetch<{ id: string }>(`/projects/${projectId}/measurement/runs`, { method: 'POST', json });

export const executeMeasurementRun = (projectId: string, runId: string) =>
  apiFetch<unknown>(`/projects/${projectId}/measurement/runs/${runId}/execute`, { method: 'POST' });


/* ── competitors ──────────────────────────────────────────────────────────
   The named list every benchmark reads from: measurement share-of-voice only
   scores answers against these names, so an empty list means no competitive
   comparison is produced at all. `discovered` are domains that out-rank this
   project on its own tracked keywords, aggregated from SERP results already
   on file — deterministic, no extra fetching. */

export interface Competitor {
  name: string;
  domain: string | null;
  source?: string;
}

export interface DiscoveredCompetitor {
  domain: string;
  appearances: number;
  bestRank: number | null;
  keyword: string | null;
}

export interface CompetitorsResponse {
  tracked: Competitor[];
  discovered: DiscoveredCompetitor[];
  /** why the benchmark is or isn't producing anything yet */
  readiness: { rivals: number; runs: number; observations: number };
  you: { total: number; mentioned: number; cited: number };
  /** ranked by how often they were named in an answer that omitted you */
  rivals: Array<{ name: string; appearances: number; share: number; beatYou: number }>;
  /** the actionable list: prompts a rival won and you did not appear in */
  losing: Array<{ prompt: string; surface: string; rivals: string[] }>;
}

export const getCompetitors = (projectId: string) =>
  apiFetch<CompetitorsResponse>(`/projects/${projectId}/competitors`);

export const setCompetitors = (projectId: string, competitors: Competitor[]) =>
  apiFetch<CompetitorsResponse>(`/projects/${projectId}/competitors`, {
    method: 'PUT',
    json: { competitors },
  });


/* ── self-report attribution ──────────────────────────────────────────────
   What the buyer says, not what analytics infers. AI referrals mostly land as
   Direct and agentic browsers present as ordinary Chrome, so asking is the
   only channel that survives. */

export interface AttributionSummary {
  total: number;
  aiTotal: number;
  /** 0..1 — the share inferred analytics systematically misses */
  aiShare: number;
  bySource: Array<{ source: string; count: number; share: number }>;
  prompts: Array<{ prompt: string; source: string; createdAt: string }>;
  recent: Array<{
    id: string;
    source: string;
    prompt: string | null;
    note: string | null;
    contactEmail: string | null;
    page: string | null;
    createdAt: string;
  }>;
  firstAt: string | null;
  lastAt: string | null;
}

export const getAttributionSummary = (projectId: string) =>
  apiFetch<AttributionSummary>(`/projects/${projectId}/attribution/summary`);

/* ── AEO audit ───────────────────────────────────────────────────────── */

/** What a run would cost, before starting it. */
export const getAeoBudget = (
  projectId: string,
  opts: { surfaces: string[]; tier: string; runCount: number; markets: number },
) =>
  apiFetch<AeoBudget>(
    `/projects/${projectId}/aeo/budget?surfaces=${encodeURIComponent(opts.surfaces.join(','))}` +
      `&tier=${encodeURIComponent(opts.tier)}&runCount=${opts.runCount}&markets=${opts.markets}`,
  );

export const getAeoContext = (projectId: string) =>
  apiFetch<AeoContext>(`/projects/${projectId}/aeo/context`);

export const buildAeoContext = (projectId: string, json: { maxPages?: number; refine?: boolean } = {}) =>
  apiFetch<AeoContext>(`/projects/${projectId}/aeo/context`, { method: 'POST', json });

export const generateAeoMatrix = (
  projectId: string,
  json: { tier?: string; refine?: boolean; activate?: boolean } = {},
) => apiFetch<AeoMatrix>(`/projects/${projectId}/aeo/matrix`, { method: 'POST', json });

export const getAeoMatrix = (projectId: string, querySetId: string, dimension?: string) =>
  apiFetch<AeoMatrix>(
    `/projects/${projectId}/aeo/matrix/${querySetId}${dimension ? `?dimension=${dimension}` : ''}`,
  );

export const listAeoAudits = (projectId: string) =>
  apiFetch<{ audits: AeoAuditSummary[] }>(`/projects/${projectId}/aeo/audits`).then((r) => r.audits);

export const getAeoAudit = (projectId: string, auditId: string) =>
  apiFetch<AeoAudit>(`/projects/${projectId}/aeo/audits/${auditId}`);

export const getAeoVerdict = (projectId: string, auditId: string) =>
  apiFetch<AeoVerdict>(`/projects/${projectId}/aeo/audits/${auditId}/verdict`);

export const startAeoAudit = (projectId: string, json: AeoRunOptions) =>
  apiFetch<AeoAudit>(`/projects/${projectId}/aeo/audits`, { method: 'POST', json });

/**
 * Advance an audit to completion. Long-running — a 100-prompt matrix at n=5 is
 * 500 prompts *per engine*, so callers should treat this as a job, not a fetch.
 */
export const resumeAeoAudit = (projectId: string, auditId: string, json: AeoRunOptions = {}) =>
  apiFetch<AeoAudit>(`/projects/${projectId}/aeo/audits/${auditId}/resume`, { method: 'POST', json });

/**
 * Start + queue the full pipeline on the backend's pipeline queue in one
 * call. Returns immediately with the audit in `pending` status — poll
 * `listAeoAudits`/`getAeoAudit` for `status`/`stage` until `completed`.
 */
export const runFullAeoAudit = (projectId: string, json: AeoRunOptions = {}) =>
  apiFetch<AeoAudit>(`/projects/${projectId}/aeo/audits/full`, { method: 'POST', json });

export const judgeAeoStance = (projectId: string, auditId: string) =>
  apiFetch<{ judged: number; skipped: number; failed: number; costUsd: number; judgeModel: string }>(
    `/projects/${projectId}/aeo/audits/${auditId}/stance`,
    { method: 'POST' },
  );

export interface AeoRunOptions {
  surface?: string;
  surfaces?: string[];
  tier?: string;
  runCount?: number;
  geo?: string;
  /** ISO-3166 alpha-2 codes, 1-5. Omit to let the backend default to the site's own top-ranked market. */
  markets?: string[];
  reuseContext?: boolean;
  skipStance?: boolean;
  skipRefine?: boolean;
}

// ─── Digital presence ──────────────────────────────────────────────────────

export const getPresence = (projectId: string) =>
  apiFetch<PresenceInventory>(`/projects/${projectId}/presence`);

/**
 * Queue a crawl of the client's site for linked profiles on the background
 * pipeline. Returns immediately with the run in `crawling` status — poll
 * `getPresenceRun` for status until `completed`/`failed`.
 *
 * `searchWeb` additionally sweeps Google for accounts the site does not link.
 * It costs one credit per platform, so it is opt-in rather than part of every
 * scan — the free crawl must never bill by accident.
 */
export const discoverPresence = (projectId: string, searchWeb = false) =>
  apiFetch<PresenceRun>(`/projects/${projectId}/presence/discover`, {
    method: 'POST',
    json: { searchWeb },
  });

export const getPresenceRun = (projectId: string, runId: string) =>
  apiFetch<PresenceRun>(`/projects/${projectId}/presence/discoveries/${runId}`);

export const addPresenceAccount = (projectId: string, url: string) =>
  apiFetch<PresenceAccount>(`/projects/${projectId}/presence/accounts`, {
    method: 'POST',
    json: { url },
  });

export const confirmPresenceCandidate = (projectId: string, accountId: string) =>
  apiFetch<PresenceAccount>(`/projects/${projectId}/presence/accounts/${accountId}/confirm`, {
    method: 'POST',
  });

export const removePresenceAccount = (projectId: string, accountId: string) =>
  apiFetch<{ deleted: true }>(`/projects/${projectId}/presence/accounts/${accountId}`, {
    method: 'DELETE',
  });

// ─── Competitors (wave-6 step 6) ───────────────────────────────────────────

/**
 * Competitors with their latest profile.
 *
 * Note the path: `/competitors/profiles`, not `/competitors`. The bare path is
 * owned by `ProjectsController` (the named list the RivalsPanel reads) and
 * returns a different shape entirely.
 */
export const listCompetitorProfiles = (projectId: string) =>
  apiFetch<{ competitors: CompetitorRow[] }>(`/projects/${projectId}/competitors/profiles`).then(
    (r) => r.competitors,
  );

/** Promote + profile. Crawls each rival's site, so it is not instant. */
export const discoverCompetitors = (projectId: string, competitors?: Array<{ name: string; domain?: string }>) =>
  apiFetch<{ projectId: string; totalCompetitors: number; promoted: number; competitors: CompetitorRow[] }>(
    `/projects/${projectId}/competitors/discover`,
    { method: 'POST', json: competitors ? { competitors } : {} },
  );

export const getCompetitorGap = (projectId: string) =>
  apiFetch<CompetitorGap>(`/projects/${projectId}/competitors/gap`);

// ─── Tech stack (wave-6 step 3) ────────────────────────────────────────────

/**
 * Latest stored scan, or null when none has run.
 *
 * The backend wraps it in `{ scan }` on purpose — a bare `null` return makes
 * Express send an empty body rather than the JSON literal, which breaks the
 * parse on this side.
 */
export const getTechStack = (projectId: string, domain?: string) =>
  apiFetch<{ scan: TechStackScan | null }>(
    `/projects/${projectId}/tech-stack${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`,
  ).then((r) => r.scan);

export const runTechStackScan = (projectId: string, domain?: string) =>
  apiFetch<TechStackScan>(`/projects/${projectId}/tech-stack/scan`, {
    method: 'POST',
    json: domain ? { domain } : {},
  });

// ─── Keyword research (wave-6 step 4) ──────────────────────────────────────

/** Research runs, newest first. Each carries its own keywords. */
export const listKeywordSets = (projectId: string, minVolume?: number) =>
  apiFetch<{ sets: KeywordSet[] }>(
    `/projects/${projectId}/keyword-research${minVolume ? `?minVolume=${minVolume}` : ''}`,
  ).then((r) => r.sets);

/**
 * Run research on seed keywords. Synchronous — the result is the response.
 * Throws a 503 naming the missing credentials when DataForSEO is not configured.
 */
export const runKeywordResearch = (
  projectId: string,
  keywords: string[],
  opts: { locationName?: string; languageCode?: string; includeRelated?: boolean } = {},
) =>
  apiFetch<KeywordSet>(`/projects/${projectId}/keyword-research`, {
    method: 'POST',
    json: { keywords, ...opts },
  });

// ─── Deliverables ──────────────────────────────────────────────────────────

export const listReports = (projectId: string) =>
  apiFetch<{ reports: ReportSummary[] }>(`/projects/${projectId}/reports`).then((r) => r.reports);

/** Snapshots current findings/scores into a shareable page. Not a live view. */
export const generateReport = (projectId: string, json: { targetUrl: string; title: string }) =>
  apiFetch<ReportSummary>(`/projects/${projectId}/reports`, { method: 'POST', json });

/** `public` makes the client's audit readable by anyone holding the link. */
export const setReportVisibility = (
  projectId: string,
  slug: string,
  visibility: 'private' | 'public',
) =>
  apiFetch<ReportSummary>(`/projects/${projectId}/reports/${slug}/visibility`, {
    method: 'PUT',
    json: { visibility },
  });

/** Returns a bare array, not an envelope. */
export const listScorecards = (projectId: string) =>
  apiFetch<ScorecardRun[]>(`/projects/${projectId}/scorecard`);
