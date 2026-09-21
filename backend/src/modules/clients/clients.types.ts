/**
 * Types for the Clients module (admin side of the lean client-management
 * layer — see README.md for what this deliberately is NOT).
 *
 * @module clients.types
 */

/**
 * C5 (`docs/analysis/client-portal.md` §5/§23/§30) adds `suspended` —
 * written only by `ClientsService.suspendClient` (an explicit admin action,
 * or the payment-failure grace-period sweep acting as the "system" actor),
 * never by the generic `PATCH /clients/:clientId`.
 */
export type ClientStatus = 'active' | 'paused' | 'churned' | 'suspended';
export type OnboardingStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * C1 (`docs/analysis/client-portal.md` §16, `docs/PLAN.md` §11.1) — state of the
 * per-project client-facing onboarding-WIZARD gate. Distinct from
 * `OnboardingStatus` above (the Day-1 bootstrapping pipeline) — see the doc
 * comment on `Project.onboardingWizardState` in `schema.prisma`.
 *
 * `waived` is deliberately its own value, not folded into `done`: a DTO or UI
 * that only distinguishes "onboarded vs not" would render a waived gate as
 * silently identical to a real Google connection, which §15 explicitly says
 * must never happen.
 */
export type OnboardingWizardState =
  | 'not-started'
  | 'confirming-details'
  | 'connecting-gsc'
  | 'connecting-ga4'
  | 'done'
  | 'waived';

export interface ClientDto {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  status: ClientStatus;
  ownerUserId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row in the admin clients list — the "progress kinda stuff" view. */
export interface ClientOverviewDto extends ClientDto {
  projectCount: number;
  /** Best (highest) current score/band across this client's projects, or null if none scored yet. */
  latestScore: number | null;
  latestBand: string | null;
  openGapCount: number;
  hasProjectOnboarding: boolean;

  // ── §3.4's client-list columns ────────────────────────────────────────
  // "A project performance score can be a secondary detail, but never confuse
  // it with account health or delivery completion" (§3.4). These are the
  // delivery facts, kept deliberately distinct from `latestScore`.
  /** Accountable staff member on the most recent engagement, by name. Null =
   *  nobody recorded one, not "no lead exists". */
  deliveryLeadName: string | null;
  /** Delivered/committed counts from the client's current cycle. `committed`
   *  is the FROZEN denominator and is never recomputed into a live count. */
  planProgress: { delivered: number; committed: number };
  /** Commitments past their target date that have not settled. */
  overdueCommitments: number;
  /** Open asks directed at the client — the same sources the per-project
   *  action queue reads, counted across every project this client owns. */
  waitingOnClient: number;
  /** The most recent RELEASED report, or null when nothing has been released.
   *  §3.4's "last report" column; drafts are deliberately excluded. */
  lastReport: { slug: string; releasedAt: string | null } | null;
}

export interface ClientProjectSummaryDto {
  id: string;
  name: string;
  domain: string;
  status: string;
  onboardingStatus: OnboardingStatus;
  onboardingStep: string | null;
  onboardingError: string | null;
  /** C1/§16 — the onboarding-WIZARD gate state, always the literal string (never
   *  collapsed to a boolean), so `waived` is never indistinguishable from `done`. */
  onboardingWizardState: OnboardingWizardState;
  latestScore: number | null;
  latestBand: string | null;
  latestReportSlug: string | null;
  openGapCount: number;
  createdAt: string;
}

export interface ClientDetailDto extends ClientDto {
  projects: ClientProjectSummaryDto[];
}

export interface ClientMessageDto {
  id: string;
  clientId: string;
  projectId: string | null;
  authorUserId: string;
  authorType: 'operator' | 'client';
  body: string;
  createdAt: string;
}

/** C5 (§5/§23) — the result of a suspend/reactivate call: the client plus which Google connections were touched. */
export interface ClientSuspensionResultDto extends ClientDto {
  /** `"<projectId>:<service>"` pairs whose Google connection was revoked as part of this suspend. Empty on reactivate. */
  googleConnectionsRevoked: string[];
}

export interface ClientLoginCreatedDto {
  userId: string;
  email: string;
  /**
   * The generated temporary password, returned exactly once — never stored
   * anywhere but the (already-hashed) User row. If Plunk delivery fails or
   * is unconfigured, this is the operator's only copy; relay it by hand.
   */
  temporaryPassword: string;
  emailSent: boolean;
  emailError: string | null;
}
