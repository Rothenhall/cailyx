/**
 * Projects Types — Backbone entity for engagements.
 *
 * A Project represents one client/venture being tracked across all
 * Cailyx modules (audits, reporting, scheduling). Maps to PLAN Phase 0.
 *
 * @module projects.types
 */

export type EngagementStatus = 'scorecard' | 'diagnostic' | 'sprint' | 'retainer' | 'archived';

export interface ProjectDto {
  id: string;
  name: string;
  domain: string;
  category: string | null;
  clientName: string | null;
  status: EngagementStatus;
  notes: string | null;
  /** Owning operator (null for rows created before auth / laminar intake). */
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Counts of linked artifacts for a project (audits, reports, gaps, schedule) */
export interface ProjectStats {
  technicalAudits: number;
  reports: number;
  entities: number;
  gaps: number;
  scheduleActive: boolean;
}