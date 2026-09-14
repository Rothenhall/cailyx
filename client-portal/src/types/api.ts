/**
 * Hand-written TS interfaces mirroring the backend's DTOs exactly — same
 * convention as frontend/src/types/api.ts. Source of truth for each type is
 * named alongside it; re-check there if the backend shape ever changes.
 *
 * @module types/api
 */

/* ── Auth (backend/src/modules/auth/auth.types.ts) ──────────────────── */

export type Role = 'admin' | 'delivery-lead' | 'content' | 'technical' | 'outreach' | 'sales';
export type UserType = 'operator' | 'client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  type: UserType;
  clientId: string | null;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/* ── Clients — admin side (backend/src/modules/clients/clients.types.ts) ── */

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

export interface ClientOverviewDto extends ClientDto {
  projectCount: number;
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
  temporaryPassword: string;
  emailSent: boolean;
  emailError: string | null;
}

/* ── Client Portal — client side (backend/src/modules/client-portal/client-portal.types.ts) ── */

export interface PortalProjectDto {
  id: string;
  name: string;
  domain: string;
  onboardingStatus: string;
  onboardingStep: string | null;
  latestScore: number | null;
  latestBand: string | null;
  lastAuditAt: string | null;
}

export interface PortalReportSummaryDto {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  scoreTotal: number;
  scoreBand: string;
  createdAt: string;
}

export interface PortalMessageDto {
  id: string;
  projectId: string | null;
  authorType: 'operator' | 'client';
  body: string;
  createdAt: string;
}

/* ── Reports list (backend/src/modules/reporting/reporting.service.ts listReports) ── */

export interface ReportSummaryDto {
  id: string;
  slug: string;
  title: string;
  targetUrl: string;
  visibility: 'private' | 'public';
  scoreTotal: number;
  scoreBand: ScoreBand;
  createdAt: string;
}

/* ── Reporting (backend/src/modules/reporting/reporting.types.ts) ──────── */

export type ScoreBand = 'invisible' | 'faint' | 'present' | 'recommended';

export interface SubScore {
  dimension: string;
  weight: number;
  value: number;
  contribution: number;
  evidence: string[];
  partial?: boolean;
  partialReason?: string;
}

export interface ReportFindingDto {
  type: string;
  status: string;
  severity: string;
  confidence: string;
  detail: Record<string, unknown>;
  recommendedFix: string;
  reproductionCommands: Array<{ bot: string; command: string; expectedResult: string }> | null;
  createdAt: string;
}

export interface ReportRoadmapDto {
  dimension: string;
  action: string;
  title: string;
  description: string;
  severity: string | null;
  priorityScore: number | null;
  status: string;
}

export interface GrowthRecommendationDto {
  category: string;
  label: string;
  title: string;
  summary: string;
  priorityRank: number;
  quickWinCount: number;
  majorProjectCount: number;
  fillInCount: number;
  thanklessTaskCount: number;
  gapIds: string[];
}

export interface GrowthFindingDto {
  gapId: string | null;
  title: string;
  whatExecutive: string;
  whatTechnical: string;
  whyExecutive: string;
  whyTechnical: string;
  fixExecutive: string;
  fixTechnical: string;
  thinRun: boolean;
  disclosedGap: string | null;
}

export interface GrowthPlanDto {
  actionPlan: {
    recommendations: GrowthRecommendationDto[];
    notCovered: string[];
    updatedAt: string;
  } | null;
  findingsCopy: GrowthFindingDto[];
  assetsNote: string;
}

/* ── Backlinks (backend/src/modules/backlinks/backlinks.types.ts) ──────── */

export type BacklinksStatus = 'pending' | 'completed' | 'partial' | 'failed';

export interface BacklinkSampleDto {
  urlFrom: string;
  urlTo: string;
  anchor: string | null;
  dofollow: boolean;
  rank: number | null;
  domainFromRank: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  itemType: string | null;
}

export interface BacklinksSummaryDto {
  id: string;
  projectId: string;
  target: string;
  status: BacklinksStatus;
  error: string | null;
  costUsd: number;
  rank: number | null;
  backlinks: number | null;
  backlinksSpamScore: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  referringPages: number | null;
  referringIps: number | null;
  referringSubnets: number | null;
  brokenBacklinks: number | null;
  brokenPages: number | null;
  firstSeen: string | null;
  lostDate: string | null;
  referringLinksTld: Record<string, number> | null;
  referringLinksTypes: Record<string, number> | null;
  referringLinksAttributes: Record<string, number> | null;
  referringLinksPlatformTypes: Record<string, number> | null;
  referringLinksCountries: Record<string, number> | null;
  topBacklinks: BacklinkSampleDto[];
  createdAt: string;
}

export interface ReportData {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  targetUrl: string;
  visibility: 'private' | 'public';
  executiveSummary: string;
  scoreTotal: number;
  scoreBand: ScoreBand;
  subScores: SubScore[];
  findings: ReportFindingDto[];
  roadmap: ReportRoadmapDto[];
  growthPlan: GrowthPlanDto | null;
  backlinks: BacklinksSummaryDto | null;
  createdAt: string;
}
