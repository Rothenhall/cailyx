/**
 * Types for the Page Analysis module (SOP-6, FR-3.3).
 *
 * @module page-analysis.types
 */

/** One H2/H3 section heading and its standalone verdict. */
export interface HeadingInfo {
  level: number;
  text: string;
  questionShaped: boolean;
  standalone: boolean;
  standaloneReason?: string;
}

/** One extractable claim ("number + noun + timeframe + source" pattern, SOP-6). */
export interface ExtractableClaim {
  text: string;
  hasNumber: boolean;
  hasTimeframe: boolean;
  hasSource: boolean;
}

/** Format-analysis finding counts (comparison tables, numbered steps, definitions). */
export interface FormatFindings {
  tables: number;
  orderedLists: number;
  definitionBlocks: number;
}

/** Deterministic structure score — disclosed weights, never renormalized. */
export interface StructureScore {
  bluf: number;
  questionH2: number;
  format: number;
  claims: number;
  total: number;
}