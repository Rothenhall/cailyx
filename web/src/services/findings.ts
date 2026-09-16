import { api, unwrap } from '@/lib/api';

/**
 * Findings adapter — RP06 and the growth-plan section of a report.
 *
 * Mirrors `backend/src/modules/findings/findings.types.ts`.
 *
 * Two shapes are involved and they are deliberately kept apart, because the
 * generate response is **not** the stored row:
 *
 *  - `GeneratedFinding` (returned by `POST .../findings/generate`) carries the
 *    LLM's answer as a nested `copy` object plus the claims-discipline
 *    `violations` it was filtered through.
 *  - `Finding` (returned by `GET .../findings`) is the persisted row, with the
 *    six copy fields flattened into columns.
 *
 * RP06 renders the **stored rows**: after a generation it re-reads the list
 * rather than displaying the mutation's own echo, so what is on screen is what
 * the project actually holds. `GeneratedFinding` is still typed here because a
 * caller needs its `violations` to explain a skipped finding honestly.
 *
 * §6.4 forbids presenting generated copy as a measurement. Every copy field
 * below is model interpretation; `thinRun`/`disclosedGap` are what keep it from
 * reading as a complete picture when the evidence behind it was thin.
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

/** One finding as returned by the generate route, before it is stored flat. */
export interface GeneratedFinding {
  gapId: string | null;
  title: string;
  copy: FindingCopy;
  /** Evidence was too thin for a non-obvious claim — see `disclosedGap`. */
  thinRun: boolean;
  /** When `thinRun`, the honest note about which evidence is missing. */
  disclosedGap: string | null;
  /** Claims-discipline hits. Empty on success; a skipped finding never lands. */
  violations: string[];
}

/**
 * One stored finding row (`GET /projects/:id/findings`).
 *
 * Every copy field is nullable in storage: a row whose copy failed to parse is
 * still a row, and a blank field must render as "not stated" rather than as an
 * empty paragraph.
 */
export interface Finding {
  id: string;
  projectId: string;
  /** The gap-analysis row this was generated from. This is the evidence link. */
  gapId: string | null;
  title: string;
  whatExecutive: string | null;
  whatTechnical: string | null;
  whyExecutive: string | null;
  whyTechnical: string | null;
  fixExecutive: string | null;
  fixTechnical: string | null;
  thinRun: boolean;
  disclosedGap: string | null;
  createdAt: string;
}

export interface FindingsList {
  findings: Finding[];
  /**
   * The backend's own verdict on the run: `true` when fewer than three
   * credible findings exist (`MIN_FINDINGS`). It is computed from the stored
   * rows, not from a request parameter — a screen must never derive this
   * itself from a count it happens to have loaded.
   */
  thinRun: boolean;
}

export interface GenerateFindingsResult {
  findings: GeneratedFinding[];
  thinRun: boolean;
}

/**
 * Stored findings for a project, newest first.
 *
 * Reads `{findings, thinRun}` through `unwrap`, so a response missing the
 * `findings` key raises instead of rendering as "no findings" (§10.2).
 */
export async function listFindings(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<FindingsList> {
  const payload = await api.get<unknown>(`/projects/${projectId}/findings`, options);
  const rows = unwrap<Finding[]>(payload, 'findings');
  if (!Array.isArray(rows)) {
    throw new Error('GET /findings answered with a non-list `findings` field.');
  }
  const thinRun = (payload as { thinRun?: unknown }).thinRun;
  return { findings: rows, thinRun: thinRun === true };
}

/**
 * Generate findings copy from the project's top open gaps.
 *
 * This is real, metered LLM work (§10.4's scan/generation row), so the screen
 * behind it must state its prerequisite (a gap analysis), require an explicit
 * start, and protect against a double submit. `limit` is clamped server-side
 * to 1–10; the default is 5.
 *
 * Throws a 503 `unavailable` when no LLM provider is configured, and a 404
 * when the project has no gap analysis — both are named conditions, not
 * failures to retry blindly.
 */
export async function generateFindings(
  projectId: string,
  input?: { limit?: number },
): Promise<GenerateFindingsResult> {
  const payload = await api.post<unknown>(`/projects/${projectId}/findings/generate`, {
    limit: input?.limit,
  });
  const rows = unwrap<GeneratedFinding[]>(payload, 'findings');
  const thinRun = (payload as { thinRun?: unknown }).thinRun;
  return { findings: rows, thinRun: thinRun === true };
}

/**
 * How many findings one generation may produce. Mirrors the server's clamp in
 * `FindingsService.generate` — showing the control's range rather than letting
 * the server silently narrow a request.
 */
export const FINDINGS_LIMIT_MIN = 1;
export const FINDINGS_LIMIT_MAX = 10;
export const FINDINGS_LIMIT_DEFAULT = 5;

/** `MIN_FINDINGS` from the backend: below this the run is disclosed as thin. */
export const FINDINGS_MIN_FOR_FULL_PICTURE = 3;
