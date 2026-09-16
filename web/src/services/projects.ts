import { api } from '@/lib/api';
import type { ProjectDetail, ProjectStatus, ProjectSummary } from './types';

/**
 * Project adapter (Appendix C.8).
 *
 * Note the envelope difference from `clients.ts`: `GET /projects` returns a
 * **bare array**, while `GET /clients` wraps its result in `{clients: [...]}`.
 * design_plan §10.2 calls this out by name — "Normalize `{projects}`,
 * `{findings, thinRun}`, `{assets}` and other wrappers explicitly rather than
 * interpreting unexpected shapes as no data" — so each adapter states which
 * shape it actually reads instead of sharing a guess.
 */

/** The artifact counts the backend computes for a project. */
export interface ProjectStats {
  technicalAudits: number;
  reports: number;
  entities: number;
  gaps: number;
  /** Whether a recurring technical-audit schedule is switched on. */
  scheduleActive: boolean;
}

export async function listProjects(
  filter?: { status?: ProjectStatus; search?: string },
  options?: { signal?: AbortSignal },
): Promise<ProjectSummary[]> {
  return api.get<ProjectSummary[]>('/projects', { ...options, query: filter });
}

export async function getProject(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<ProjectDetail & { stats: ProjectStats }> {
  return api.get<ProjectDetail & { stats: ProjectStats }>(`/projects/${projectId}`, options);
}

export async function createProject(input: {
  name: string;
  domain: string;
  category?: string;
  clientName?: string;
}) {
  return api.post<{ id: string; name: string; domain: string }>('/projects', input);
}

export async function updateProject(
  projectId: string,
  input: { name?: string; category?: string; clientName?: string; notes?: string },
) {
  return api.patch<ProjectSummary>(`/projects/${projectId}`, input);
}

/**
 * Deletes a project. Admin only, and irreversible.
 *
 * Deliberately a separate export rather than an option on `updateProject`:
 * the two carry completely different consequences, and a destructive action
 * should be impossible to reach by passing a field.
 */
export async function deleteProject(projectId: string) {
  return api.delete<void>(`/projects/${projectId}`);
}

/**
 * The fields `GET /projects/:id` actually returns, as distinct from the
 * richer `ProjectSummary` shape the list route returns.
 *
 * Worth stating because PJ02 needs to know what it may offer an edit for: the
 * detail route does not carry `clientId`, `engagementId` or `timezone`, so
 * client association and domain identity cannot even be *displayed* here, let
 * alone changed (design_plan G04 tracks the missing contract). Reading a
 * missing field as "not set" would show a project as unassociated when it is
 * merely unreported.
 */
export interface ProjectDetailWire {
  id: string;
  name: string;
  domain: string;
  category: string | null;
  clientName: string | null;
  status: ProjectStatus;
  notes: string | null;
  competitors: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  stats: ProjectStats;
}

export async function getProjectDetail(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<ProjectDetailWire> {
  return api.get<ProjectDetailWire>(`/projects/${projectId}`, options);
}

/**
 * Moves a project through its engagement lifecycle
 * (`scorecard → diagnostic → sprint → retainer → archived`).
 *
 * Kept separate from `updateProject` because it carries different consequences
 * — it changes what the client is understood to have bought — and §10.4 wants
 * a status edit to confirm the server's result rather than ride along with a
 * field edit. §8.1 adds the sharper reason: the transition action carries a
 * policy that a generic PATCH would bypass, so the two must not be the same
 * call.
 */
export async function transitionProject(projectId: string, to: ProjectStatus) {
  return api.put<ProjectSummary>(`/projects/${projectId}/transition`, { status: to });
}

/**
 * The transitions the server will accept from a given status. Mirrors
 * `LIFECYCLE` in `projects.service.ts` exactly.
 *
 * This is a *display* aid so the screen can show which moves are available;
 * the server still validates, and a 409 from it is the authority.
 */
export const LIFECYCLE_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  scorecard: ['diagnostic', 'archived'],
  diagnostic: ['sprint', 'archived'],
  sprint: ['retainer', 'diagnostic', 'archived'],
  retainer: ['diagnostic', 'archived'],
  archived: ['diagnostic'],
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  scorecard: 'Scorecard',
  diagnostic: 'Diagnostic',
  sprint: 'Sprint',
  retainer: 'Retainer',
  archived: 'Archived',
};
