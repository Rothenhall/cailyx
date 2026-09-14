/**
 * Typed helper functions, one per backend endpoint — same convention as
 * frontend/src/lib/terminal-api.ts. Every function is a thin call into
 * apiFetch(); response/request shapes come from @/types/api.
 *
 * @module lib/endpoints
 */

import { apiFetch } from './api';
import type {
  AuthResponse,
  AuthUser,
  ClientOverviewDto,
  ClientDetailDto,
  ClientDto,
  ClientProjectSummaryDto,
  ClientMessageDto,
  ClientLoginCreatedDto,
  PortalProjectDto,
  PortalReportSummaryDto,
  PortalMessageDto,
  ReportData,
  ReportSummaryDto,
} from '@/types/api';

/* ── Auth ────────────────────────────────────────────────────── */

export const login = (email: string, password: string) =>
  apiFetch<AuthResponse>('/auth/login', { method: 'POST', json: { email, password } });

export const getMe = () => apiFetch<AuthUser>('/auth/me');

/* ── Admin: clients ──────────────────────────────────────────── */

export const listClients = () => apiFetch<{ clients: ClientOverviewDto[] }>('/clients');

export const createClient = (input: { name: string; contactName?: string; contactEmail?: string; notes?: string }) =>
  apiFetch<ClientDto>('/clients', { method: 'POST', json: input });

export const getClient = (clientId: string) => apiFetch<ClientDetailDto>(`/clients/${clientId}`);

export const updateClient = (
  clientId: string,
  patch: Partial<{ name: string; contactName: string; contactEmail: string; status: string; notes: string }>,
) => apiFetch<ClientDto>(`/clients/${clientId}`, { method: 'PATCH', json: patch });

export const createClientProject = (clientId: string, input: { name: string; domain: string }) =>
  apiFetch<ClientProjectSummaryDto>(`/clients/${clientId}/projects`, { method: 'POST', json: input });

export const createClientLogin = (clientId: string, input: { email: string; name?: string }) =>
  apiFetch<ClientLoginCreatedDto>(`/clients/${clientId}/login`, { method: 'POST', json: input });

export const listClientMessages = (clientId: string) =>
  apiFetch<{ messages: ClientMessageDto[] }>(`/clients/${clientId}/messages`);

export const postClientMessage = (clientId: string, body: string, projectId?: string) =>
  apiFetch<ClientMessageDto>(`/clients/${clientId}/messages`, { method: 'POST', json: { body, projectId } });

/* ── Admin: reports (operator-shaped, project-scoped) ───────────── */

export const getReport = (projectId: string, slug: string) =>
  apiFetch<ReportData>(`/projects/${projectId}/reports/${slug}/view`);

export const listReportsForProject = (projectId: string) =>
  apiFetch<{ reports: ReportSummaryDto[] }>(`/projects/${projectId}/reports`);

/* ── Client portal ───────────────────────────────────────────── */

export const listPortalProjects = () => apiFetch<{ projects: PortalProjectDto[] }>('/portal/projects');

export const listPortalReports = () => apiFetch<{ reports: PortalReportSummaryDto[] }>('/portal/reports');

export const getPortalReport = (slug: string) => apiFetch<ReportData>(`/portal/reports/${slug}`);

export const listPortalMessages = () => apiFetch<{ messages: PortalMessageDto[] }>('/portal/messages');

export const postPortalMessage = (body: string, projectId?: string) =>
  apiFetch<PortalMessageDto>('/portal/messages', { method: 'POST', json: { body, projectId } });
