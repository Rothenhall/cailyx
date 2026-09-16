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
  /**
   * G05 — which revision this client-visible report is, and when it was
   * released to them. Both are release facts read from the frozen revision;
   * `createdAt` above stays what it always meant (when the content was
   * assembled), which for a released report is the snapshot's own content
   * time — not the release time.
   */
  revision: number;
  releasedAt: string | null;
}

export interface PortalMessageDto {
  id: string;
  projectId: string | null;
  authorType: 'operator' | 'client';
  body: string;
  createdAt: string;
}
