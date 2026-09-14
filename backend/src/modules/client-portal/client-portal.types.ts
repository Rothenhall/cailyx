/**
 * Types for the Client Portal module — what an authenticated client-type
 * User sees. Deliberately narrow: project status, reports, messages. See
 * README.md for what this is NOT (the full docs/analysis/client-portal.md
 * plan).
 *
 * @module client-portal.types
 */

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
