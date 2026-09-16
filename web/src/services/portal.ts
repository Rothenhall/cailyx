import { api, unwrap } from '@/lib/api';
import type { PortalProject } from './types';
import type { ReportData } from './reports';

/**
 * Client-portal adapter (Appendix C.7).
 *
 * Every function here is scoped by the **server** from the caller's JWT. None
 * of them takes a `clientId` argument, and that absence is the point: a client
 * cannot ask for another client's data by editing a parameter, and no caller
 * has to remember to pass the right scope (design_plan §10.1, G03).
 *
 * These are the read models the client portal is allowed to see. Where a
 * figure is missing — a project never scored — it comes back `null` and is
 * rendered as "not measured", never as zero (§3.5).
 */

export interface PortalReportSummary {
  id: string;
  slug: string;
  title: string;
  /** ISO 8601. */
  createdAt: string;
  scoreTotal?: number | null;
  scoreBand?: string | null;
  projectId?: string;
  projectName?: string;
}

export async function listPortalProjects(options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ projects: PortalProject[] }>('/portal/projects', options);
  return unwrap<PortalProject[]>(payload, 'projects');
}

/**
 * A project as `GET /api/portal/projects` actually returns it today
 * (`client-portal.types.ts` → `PortalProjectDto`).
 *
 * This is a second, correctly-typed read of the same endpoint rather than a
 * replacement for {@link listPortalProjects}: that one is typed by
 * `services/types.ts`'s `PortalProject`, which declares `status` and `score` —
 * fields the backend does not send (it sends `onboardingStatus` and
 * `latestScore`). `services/types.ts` is outside this build's write scope, so
 * the corrected shape lives here and the CP02 screen binds to this instead.
 *
 * `lastAuditAt` is the **latest report's** created time, not an audit-run
 * timestamp — design_plan §4.5 CP02 flags exactly this ("source uses report
 * time as lastAuditAt, label carefully"), so no screen may print it as
 * "last audit".
 */
export interface PortalProjectSummary {
  id: string;
  name: string;
  domain: string;
  /** Day-1 pipeline progress: pending | running | completed | failed. */
  onboardingStatus: string | null;
  /** The stage currently running or failed. Null once complete. */
  onboardingStep: string | null;
  /** Latest REPORT score. Null when no report has ever been generated. */
  latestScore: number | null;
  latestBand: string | null;
  /** Latest report's created time. Not an audit timestamp — see above. */
  lastAuditAt: string | null;
}

export async function listPortalProjectSummaries(options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ projects: PortalProjectSummary[] }>('/portal/projects', options);
  return unwrap<PortalProjectSummary[]>(payload, 'projects');
}

export async function listPortalReports(options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ reports: PortalReportSummary[] }>('/portal/reports', options);
  return unwrap<PortalReportSummary[]>(payload, 'reports');
}

/**
 * A released report, by slug.
 *
 * The backend returns 404 both when the report does not exist and when it
 * belongs to a different client — deliberately, so this cannot be used to probe
 * for other clients' report slugs. Screens must therefore render the same
 * "not available" copy for both cases.
 *
 * The payload is the same `ReportData` an operator's report reader receives,
 * with one difference that matters: `Report.visibility: "private"` means "not
 * publicly link-shareable", not "hidden from the client", so the client reads
 * their own report either way. It is returned as **JSON**, never as HTML — §10.5
 * forbids injecting fetched markup.
 */
export async function getPortalReport(slug: string, options?: { signal?: AbortSignal }) {
  return api.get<ReportData>(`/portal/reports/${encodeURIComponent(slug)}`, options);
}

/**
 * The signed-in client's own identity (G01 `GET /api/portal/me`).
 *
 * Distinct from the operator `SafeUser`: it never carries `role`, and it always
 * carries the Client the login belongs to.
 *
 * NOTE (2026-09): this route is **not registered** in the running backend.
 * `AuthService.getPortalMe` exists and returns exactly this shape, but no
 * `@ClientPortal()` controller exposes it — `AuthController`'s `me` is
 * operator-only by design. Calls therefore 404 until the controller ships, and
 * screens must render that as an explicit unavailable state rather than as an
 * empty profile.
 */
export interface PortalMe {
  id: string;
  email: string;
  name: string;
  type: 'client';
  /** Drives the forced first-password-change flow — see the CP15 note. */
  mustChangePassword: boolean;
  client: {
    id: string;
    name: string;
    status: string;
  };
  createdAt: string;
}

export async function getPortalMe(options?: { signal?: AbortSignal }) {
  return api.get<PortalMe>('/portal/me', options);
}
