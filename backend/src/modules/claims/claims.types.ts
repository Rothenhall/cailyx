/**
 * Types for the Claims module (FR-9.4 claims discipline).
 *
 * @module claims.types
 */

/** A/B/C stat grades. */
export type ClaimGrade = 'A' | 'B' | 'C';

export const GRADES: ClaimGrade[] = ['A', 'B', 'C'];

/** Outcome of a claims-discipline check (FR-9.4). */
export type CheckResult = 'passed' | 'banned-phrase' | 'ungraded-number' | 'single-run-rate';

export const CHECK_RESULTS: CheckResult[] = ['passed', 'banned-phrase', 'ungraded-number', 'single-run-rate'];

/** Claim status lifecycle: only `passed` claims can be approved. */
export type ClaimStatus = 'draft' | 'approved' | 'blocked';

export const CLAIM_STATUSES: ClaimStatus[] = ['draft', 'approved', 'blocked'];

/** The seeded banned-phrase list (PRD FR-9.4: "rank #1", "guaranteed", variants). */
export const BANNED_PHRASES: string[] = [
  'rank #1',
  'rank no. 1',
  'ranked #1',
  '#1 in',
  'guaranteed',
  'we guarantee',
  'best in class',
  'world-class',
  'industry-leading',
  'number one choice',
];

/** One banned-phrase hit in checked copy. */
export interface BannedHit {
  phrase: string;
  match: string;
}

/** Full discipline-check report for a piece of copy. */
export interface CheckReport {
  result: CheckResult;
  banned: BannedHit[];
  /** Numeric statements found in the copy that would need a graded source. */
  numericClaims: string[];
  /** Copy reads like a rate/percentage without multi-run provenance. */
  singleRunRate: boolean;
  /** Human-readable violation list (empty when passed). */
  violations: string[];
}