/**
 * Typed API helpers for the Cailyx operator dashboard.
 *
 * @module lib/terminal-api
 */

import { apiFetch } from './api';
import type { User } from '@/types/api';
import type {
  AgentsResponse,
  IntegrationsResponse,
  LinkGraph,
  ProjectDetail,
  SafeUser,
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

export const listAudits = (projectId: string) =>
  apiFetch<{ audits: Array<{ id: string; createdAt: string; targetUrl: string; findings: unknown[] }> }>(
    `/projects/${projectId}/technical-audit`,
  ).then((r) => r.audits);

export const getAudit = (projectId: string, auditId: string) =>
  apiFetch<TechnicalAudit>(`/projects/${projectId}/technical-audit/${auditId}`);

export const runAudit = (projectId: string, targetUrl: string) =>
  apiFetch<TechnicalAudit>(`/projects/${projectId}/technical-audit/run`, {
    method: 'POST',
    json: { targetUrl },
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
