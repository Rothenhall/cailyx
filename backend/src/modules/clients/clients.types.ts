/**
 * Types for the Clients module (admin side of the lean client-management
 * layer — see README.md for what this deliberately is NOT).
 *
 * @module clients.types
 */

export type ClientStatus = 'active' | 'paused' | 'churned';
export type OnboardingStatus = 'pending' | 'running' | 'completed' | 'failed';

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
}

export interface ClientProjectSummaryDto {
  id: string;
  name: string;
  domain: string;
  status: string;
  onboardingStatus: OnboardingStatus;
  onboardingStep: string | null;
  onboardingError: string | null;
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
