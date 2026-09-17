/**
 * Shared domain types for the service layer.
 *
 * These describe what the backend **actually returns today**, verified against
 * `backend/openapi.json` and the source. design_plan.md §10.2 is explicit that
 * generated types alone do not certify runtime behavior, so where a field is
 * nullable or an envelope is inconsistent it is written down here rather than
 * assumed away.
 */

export type OperatorRole =
  | 'admin'
  | 'delivery-lead'
  | 'content'
  | 'technical'
  | 'outreach'
  | 'sales';

export type UserType = 'operator' | 'client';

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: OperatorRole;
  type: UserType;
  clientId: string | null;
  createdAt: string;
  /** G01 — drives the forced first-password-change flow (screen AU04). */
  mustChangePassword?: boolean;
}

export type ClientStatus = 'active' | 'paused' | 'churned';

export interface ClientSummary {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  status: ClientStatus;
  ownerUserId: string | null;
  notes: string | null;
  projectCount: number;
  /**
   * The HIGHEST latest score across this client's projects — **not** an
   * aggregate health score. design_plan G14 (line 1683) is explicit that it
   * must be labelled as what it is until a real aggregate contract exists.
   * Null when no project has ever been scored: that is "not measured", not 0.
   */
  latestScore: number | null;
  latestBand: string | null;

  // ── §3.4's client-list columns ────────────────────────────────────────
  // "A project performance score can be a secondary detail, but never confuse
  // it with account health or delivery completion." These are the delivery
  // facts, deliberately kept separate from `latestScore` above.
  /** Accountable staff member on the most recent engagement. Null = nobody
   *  recorded one — not "no lead exists". */
  deliveryLeadName: string | null;
  /** Current cycle's delivered/committed counts. `committed` is the FROZEN
   *  denominator, never recomputed into a live count. */
  planProgress: { delivered: number; committed: number };
  /** Commitments past their target date that have not settled. */
  overdueCommitments: number;
  /** Open asks directed at the client, counted across their projects. */
  waitingOnClient: number;
  /** The most recent RELEASED report. Null when nothing has been released;
   *  drafts are deliberately excluded. */
  lastReport: { slug: string; releasedAt: string | null } | null;

  createdAt: string;
  updatedAt: string;
}

/** Engagement lifecycle of a project, not its onboarding progress. */
export type ProjectStatus =
  | 'scorecard'
  | 'diagnostic'
  | 'sprint'
  | 'retainer'
  | 'archived';

/** Progress of the day-1 pipeline. Orthogonal to `ProjectStatus`. */
export type OnboardingStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ProjectSummary {
  id: string;
  name: string;
  domain: string;
  status: ProjectStatus;
  clientId?: string | null;
  onboardingStatus?: OnboardingStatus;
  /** Named stage currently running or failed. Null once complete. */
  onboardingStep?: string | null;
  onboardingError?: string | null;
  score?: number | null;
  band?: string | null;
}

export interface ClientDetail extends Omit<ClientSummary, 'projectCount'> {
  projects: ProjectSummary[];
}

export interface ProjectDetail extends ProjectSummary {
  category: string | null;
  notes: string | null;
  timezone?: string;
  /** Artifact counts. Shape varies by what has run; read defensively. */
  stats: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A client's own view of their project. Deliberately narrower.
 *
 * Field names match `PortalProjectDto` in the backend exactly. An earlier
 * version of this type declared `status`/`score`/`band` — none of which the
 * route sends — so a screen binding to it rendered an unlabelled status pill
 * and "Not measured yet" for a project that had a score. Reading a renamed
 * field as absent is the §10.2 failure mode, so the names are stated once here
 * and every portal screen binds to this.
 */
export interface PortalProject {
  id: string;
  name: string;
  domain: string;
  /** Day-1 pipeline progress — NOT the engagement lifecycle. */
  onboardingStatus: string;
  onboardingStep: string | null;
  /** The latest *report* score. Null when no report has ever been generated. */
  latestScore: number | null;
  latestBand: string | null;
  /**
   * The latest report's created time. **Not an audit timestamp** — design_plan
   * §4.5 CP02 flags that the source uses report time here, so no screen may
   * print this as "last audit".
   */
  lastAuditAt: string | null;
}
