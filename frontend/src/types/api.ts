/**
 * Shared API entity types for the frontend (mirrors backend modules).
 *
 * @module types/api
 */

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken?: string;
  user: User;
}

export type EngagementStage =
  | 'scorecard'
  | 'diagnostic'
  | 'sprint'
  | 'retainer'
  | 'archived';

export interface Project {
  id: string;
  name: string;
  domain: string;
  status?: EngagementStage | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A named scorecard problem (Rung-0 output). */
export interface ScorecardProblem {
  dimension: string;
  value: number | null;
  why: string;
  fix: string;
  evidence: string[];
}