import { ApiError, api } from '@/lib/api';

/**
 * Page-analysis adapters — SOP-6 answer-engine extractability (CT07).
 *
 * The contract that shapes this file is §5.8 Stage E's boundary: *"Page-analysis
 * currently fetches a URL; it cannot grade an unsaved draft body."* So every
 * function here takes a **URL**, not a body, and the screen says so — a draft
 * in the editor has to be published (or reachable) before this can measure it.
 *
 * `analyzePage` persists a row per call and is throttled to 10/minute. It is a
 * deliberate operator action and is **never** called on page load.
 */

/** Weights the deterministic pipeline uses, in the order it adds them up. */
export const STRUCTURE_WEIGHTS = {
  bluf: 30,
  questionH2: 25,
  format: 25,
  claims: 20,
} as const;

/** One H2/H3 section heading and its standalone verdict. */
export interface HeadingInfo {
  level: number;
  text: string;
  questionShaped: boolean;
  standalone: boolean;
  standaloneReason?: string;
}

/** One extractable claim: "number + noun + timeframe + source" pattern (SOP-6). */
export interface ExtractableClaim {
  text: string;
  hasNumber: boolean;
  hasTimeframe: boolean;
  hasSource: boolean;
}

export interface FormatFindings {
  tables: number;
  orderedLists: number;
  definitionBlocks: number;
}

export interface PageAnalysisRow {
  id: string;
  projectId: string;
  url: string;
  title: string | null;
  wordCount: number;
  /** 0–30. */
  blufScore: number;
  /** 0–25. */
  questionH2Score: number;
  /** 0–25. */
  formatScore: number;
  /** 0–20. */
  claimsScore: number;
  /** Sum of the four subscores, 0–100. Never renormalized. */
  structureScore: number;
  blufText: string | null;
  /** JSON string: HeadingInfo[]. Decoded by `decodeAnalysisDetail`. */
  headingStructure: string;
  /** JSON string: ExtractableClaim[]. */
  extractableClaims: string;
  /** JSON string: FormatFindings. */
  formatFindings: string;
  /** Optional model refinement. Never part of `structureScore`. */
  llmNotes: string | null;
  fetchedAt: string | null;
  /** `complete` or `fetch-failed`. A fetch-failed row carries no analysis at all. */
  status: string;
  createdAt: string;
}

const EMPTY_FORMAT: FormatFindings = { tables: 0, orderedLists: 0, definitionBlocks: 0 };

/** The decoded halves of a row. Malformed JSON decodes to empty, never throws a screen. */
export interface DecodedAnalysis {
  headings: HeadingInfo[];
  claims: ExtractableClaim[];
  format: FormatFindings;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * Decodes the three JSON-string columns.
 *
 * The API returns them as strings (the controller documents
 * *"headings/claims/format JSON decoded as strings"*), so decoding is the
 * adapter's job rather than each screen's.
 */
export function decodeAnalysisDetail(row: PageAnalysisRow): DecodedAnalysis {
  return {
    headings: parseJson<HeadingInfo[]>(row.headingStructure, []),
    claims: parseJson<ExtractableClaim[]>(row.extractableClaims, []),
    format: parseJson<FormatFindings>(row.formatFindings, EMPTY_FORMAT),
  };
}

function asArray(payload: unknown): PageAnalysisRow[] {
  if (Array.isArray(payload)) return payload as PageAnalysisRow[];
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: 'Expected a list of page analyses but the response was not an array.',
    body: payload,
  });
}

/** History for the project, newest first. Live URL only — no draft grading. */
export async function listPageAnalyses(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<PageAnalysisRow[]> {
  const payload = await api.get<unknown>(`/projects/${projectId}/page-analysis`, options);
  return asArray(payload);
}

export async function getPageAnalysis(
  projectId: string,
  analysisId: string,
  options?: { signal?: AbortSignal },
): Promise<PageAnalysisRow> {
  const payload = await api.get<unknown>(
    `/projects/${projectId}/page-analysis/${analysisId}`,
    options,
  );
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as PageAnalysisRow;
  }
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: 'Expected a single page analysis but the response was not an object.',
    body: payload,
  });
}

/**
 * Fetch and analyze one URL. Deterministic, and persisted so restructures stay
 * comparable over time.
 *
 * `useLlm` adds Claude `llmNotes`, which are **stored and never scored** — a
 * model's reading must not move a measured number. Without an Anthropic key the
 * server answers 503 rather than silently skipping it.
 */
export async function analyzePage(
  projectId: string,
  input: { url: string; useLlm?: boolean },
): Promise<PageAnalysisRow> {
  const payload = await api.post<unknown>(`/projects/${projectId}/page-analysis/analyze`, input);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    // The analyze response also carries `analysis` (the in-memory result) and
    // `fetchStatus`; the persisted row fields are what every screen reads.
    return payload as PageAnalysisRow;
  }
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: 'The analysis completed but the response was not a page analysis row.',
    body: payload,
  });
}
