/**
 * Types for the Findings module (PRD FR-9.1–9.3).
 *
 * @module findings.types
 */

/** The two registers every generated attribute is written in (FR-9.3). */
export interface FindingCopy {
  whatExecutive: string;
  whatTechnical: string;
  whyExecutive: string;
  whyTechnical: string;
  fixExecutive: string;
  fixTechnical: string;
}

/** Generated result stored on a Finding row. */
export interface GeneratedFinding {
  gapId: string | null;
  title: string;
  copy: FindingCopy;
  thinRun: boolean;
  /** When thinRun, an honest note about which evidence is missing. */
  disclosedGap: string | null;
  /** Claims-discipline violations found in the generated copy (always empty on success). */
  violations: string[];
}

/** Non-obvious threshold (FR-9.1): a finding must explain something an operator
 *  could not see from the raw audit alone — we approximate by requiring evidence
 *  from at least two modules OR severity high enough to be un-inferable. */
export const NON_OBVIOUS_MIN_EVIDENCE = 2;

/** If fewer than this many credible findings can be generated, the run is thin. */
export const MIN_FINDINGS = 3;