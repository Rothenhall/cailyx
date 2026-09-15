/**
 * Typed API calls for the admin/client-management console (`/admin/**`).
 * Thin wrappers over the shared `apiFetch` client — see backend/openapi.json
 * for the source of truth on each shape.
 *
 * @module lib/admin-api
 */

import { apiFetch } from '@/lib/api';
import type { User } from '@/types/api';
import type {
  AuditCadence,
  AuditSchedule,
  ClientDetail,
  ClientListItem,
  ClientMessage,
  ClientStatus,
  CompetitorCandidate,
  Finding,
  GoogleConnection,
  GoogleService,
  MonitoringCadence,
  MonitoringSchedule,
  ReportSummary,
} from '@/types/admin';

export function getMe(): Promise<User> {
  return apiFetch<User>('/auth/me');
}

/* ── clients ──────────────────────────────────────────────────── */

export async function listClients(): Promise<ClientListItem[]> {
  const res = await apiFetch<{ clients: ClientListItem[] }>('/clients');
  return res.clients;
}

export function createClient(input: {
  name: string;
  contactName?: string;
  contactEmail?: string;
  notes?: string;
}): Promise<{ id: string; name: string; status: ClientStatus; createdAt: string }> {
  return apiFetch('/clients', { method: 'POST', json: input });
}

export function getClient(clientId: string): Promise<ClientDetail> {
  return apiFetch<ClientDetail>(`/clients/${clientId}`);
}

/** "Add client -> run the pipeline" — creates the project and kicks off the
 * full Day-1 audit-to-report pipeline in the background. The four `run*`
 * flags are opt-in stages with real per-run cost (Cloro/LLM/DataForSEO
 * credits) — omit or leave false to skip them. Entity-audit and findings-copy
 * are NOT flags here: they're free and always run as part of the pipeline. */
export function createClientProject(
  clientId: string,
  input: {
    name: string;
    domain: string;
    runAeoAudit?: boolean;
    runKeywordResearch?: boolean;
    runGrowthExecution?: boolean;
    runBacklinksRefresh?: boolean;
  },
): Promise<{ id: string; name: string; domain: string; onboardingStatus: string }> {
  return apiFetch(`/clients/${clientId}/projects`, { method: 'POST', json: input });
}

/* ── messages ─────────────────────────────────────────────────── */

export async function listMessages(clientId: string): Promise<ClientMessage[]> {
  const res = await apiFetch<{ messages: ClientMessage[] }>(`/clients/${clientId}/messages`);
  return res.messages;
}

export function postMessage(clientId: string, body: string, projectId?: string): Promise<ClientMessage> {
  return apiFetch(`/clients/${clientId}/messages`, { method: 'POST', json: { body, projectId } });
}

/* ── google integration ──────────────────────────────────────── */

export function getGoogleConnections(): Promise<GoogleConnection[]> {
  return apiFetch<GoogleConnection[]>('/integrations/google/connections');
}

export function authorizeGoogle(service: GoogleService, projectId?: string): Promise<{ url: string }> {
  return apiFetch('/integrations/google/authorize', { method: 'POST', json: { service, projectId } });
}

/* ── findings ─────────────────────────────────────────────────── */

export async function listFindings(projectId: string): Promise<Finding[]> {
  const res = await apiFetch<{ findings: Finding[]; thinRun?: boolean }>(`/projects/${projectId}/findings`);
  return res.findings;
}

export async function generateFindings(projectId: string, limit = 5): Promise<Finding[]> {
  const res = await apiFetch<{ findings: Finding[] }>(`/projects/${projectId}/findings/generate`, {
    method: 'POST',
    json: { limit },
  });
  return res.findings as unknown as Finding[];
}

/* ── reports ──────────────────────────────────────────────────── */

export async function listReports(projectId: string): Promise<ReportSummary[]> {
  const res = await apiFetch<{ reports: ReportSummary[] }>(`/projects/${projectId}/reports`);
  return res.reports;
}

export function reportRenderUrl(projectId: string, slug: string): string {
  const base =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:3002';
  return `${base}/api/projects/${projectId}/reports/${slug}/render`;
}

/* ── competitors ──────────────────────────────────────────────── */

/** Brand names an AI surface mentioned that aren't already a recorded competitor — pending review. */
export async function listCompetitorCandidates(projectId: string): Promise<CompetitorCandidate[]> {
  const res = await apiFetch<{ candidates: CompetitorCandidate[] }>(`/projects/${projectId}/competitors/candidates`);
  return res.candidates;
}

/** Promote a candidate to a tracked competitor — also appended to Project.competitors. */
export function confirmCompetitorCandidate(projectId: string, competitorId: string): Promise<CompetitorCandidate> {
  return apiFetch(`/projects/${projectId}/competitors/candidates/${competitorId}/confirm`, { method: 'POST' });
}

/** Discard a candidate. */
export function rejectCompetitorCandidate(projectId: string, competitorId: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/projects/${projectId}/competitors/candidates/${competitorId}`, { method: 'DELETE' });
}

/* ── scheduling ───────────────────────────────────────────────── */

export function getTechnicalAuditSchedule(projectId: string): Promise<AuditSchedule> {
  return apiFetch<AuditSchedule>(`/projects/${projectId}/technical-audit/schedule`);
}
export function setTechnicalAuditSchedule(projectId: string, cadence: AuditCadence): Promise<AuditSchedule> {
  return apiFetch(`/projects/${projectId}/technical-audit/schedule`, { method: 'PUT', json: { cadence } });
}

export function getSeoAuditSchedule(projectId: string): Promise<AuditSchedule> {
  return apiFetch<AuditSchedule>(`/projects/${projectId}/seo-audit/schedule`);
}
export function setSeoAuditSchedule(projectId: string, cadence: AuditCadence): Promise<AuditSchedule> {
  return apiFetch(`/projects/${projectId}/seo-audit/schedule`, { method: 'PUT', json: { cadence } });
}

export function getMonitoringSchedule(projectId: string): Promise<MonitoringSchedule> {
  return apiFetch<MonitoringSchedule>(`/projects/${projectId}/monitoring/schedule`);
}
export function setMonitoringSchedule(
  projectId: string,
  cadence: MonitoringCadence,
): Promise<MonitoringSchedule> {
  return apiFetch(`/projects/${projectId}/monitoring/schedule`, { method: 'PUT', json: { cadence } });
}
