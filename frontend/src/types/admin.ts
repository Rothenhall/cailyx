/**
 * Types for the admin/client-management console (`/admin/**`).
 * Mirrors the Clients / Intake / Integrations(Google) / Findings / Reporting /
 * Monitoring / Technical-Audit / SEO-Audit backend modules — see
 * backend/openapi.json for the source of truth.
 *
 * @module types/admin
 */

export type ClientStatus = 'active' | 'paused' | 'churned';

export interface ClientListItem {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  status: ClientStatus;
  ownerUserId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  projectCount: number;
  latestScore: number | null;
  latestBand: string | null;
  openGapCount: number;
  hasProjectOnboarding: boolean;
}

export type OnboardingStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ClientProject {
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

export interface ClientDetail {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  status: ClientStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  projects: ClientProject[];
}

export interface ClientMessage {
  id: string;
  clientId: string;
  projectId: string | null;
  authorUserId: string;
  authorType: 'operator' | 'client';
  body: string;
  createdAt: string;
}

export type GoogleService = 'search-console' | 'analytics';

export interface GoogleConnection {
  service: GoogleService;
  connected: boolean;
  googleEmail: string | null;
  scope: string;
  connectedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  lastError: string | null;
}

export interface ReportSummary {
  id: string;
  slug: string;
  title: string;
  targetUrl?: string;
  visibility: 'private' | 'public';
  scoreTotal?: number | null;
  scoreBand?: string | null;
  createdAt: string;
}

export interface FindingCopy {
  whatExecutive: string;
  whatTechnical: string;
  whyExecutive: string;
  whyTechnical: string;
  fixExecutive: string;
  fixTechnical: string;
}

export interface Finding {
  id: string;
  gapId: string | null;
  title: string;
  whatExecutive: string;
  whyExecutive: string;
  fixExecutive: string;
  thinRun: boolean;
  createdAt: string;
}

export interface CompetitorCandidate {
  id: string;
  projectId: string;
  name: string;
  domain: string | null;
  source: string;
  status: string;
  createdAt: string;
}

export type AuditCadence = 'daily' | 'weekly' | 'monthly' | 'manual-only';
export type MonitoringCadence = 'weekly' | 'monthly' | 'manual-only';

export interface AuditSchedule {
  cadence: AuditCadence;
  nextRunAt?: string | null;
}

export interface MonitoringSchedule {
  cadence: MonitoringCadence;
  nextRunAt?: string | null;
}
