import { api } from '@/lib/api';

/**
 * Claim-library adapter (Appendix C.14) — design_plan.md CL01 and CL02.
 *
 * A claim is a factual assertion the agency may put in front of a client's
 * audience, and the discipline around it is the point of the module: a claim
 * carries a **grade** that says how well it is evidenced, and the check result
 * records what the discipline engine made of it.
 *
 * The vocabulary is fixed and small, so it is enumerated here rather than left
 * as `string` — a screen that has to guess whether `single-run-rate` is a grade
 * or a check outcome will guess wrong.
 */

/** A (own n>=5 measurement) | B (≥2 independent sources) | C (single source). */
export type ClaimGrade = 'A' | 'B' | 'C';

/**
 * What the last discipline check concluded.
 *
 * `banned-phrase`, `ungraded-number` and `single-run-rate` are **refusals**, not
 * warnings: a claim in one of those states can never be approved, which is why
 * the detail screen treats them as blocking rather than as advice.
 */
export type ClaimCheckResult =
  | 'pending'
  | 'passed'
  | 'banned-phrase'
  | 'ungraded-number'
  | 'single-run-rate';

export type ClaimStatus = 'draft' | 'approved' | 'blocked';

export interface Claim {
  id: string;
  projectId: string;
  statement: string;
  sourceUrl: string | null;
  sourceName: string | null;
  /** Null until a check has graded it. */
  grade: ClaimGrade | null;
  gradeReason: string | null;
  checkResult: ClaimCheckResult;
  /** JSON string — the detail of the last discipline check. */
  checkJson: string;
  status: ClaimStatus;
  createdAt: string;
  updatedAt: string;
}

export async function listClaims(
  projectId: string,
  status?: ClaimStatus,
  options?: { signal?: AbortSignal },
): Promise<Claim[]> {
  // A bare array, not a wrapper — the claims list route is one of the ones
  // Appendix B's D12 warns about. Read defensively rather than assuming.
  const payload = await api.get<unknown>(`/projects/${projectId}/claims`, {
    ...options,
    query: { status },
  });
  if (!Array.isArray(payload)) {
    throw new Error('GET /projects/:id/claims answered with something other than a list.');
  }
  return payload as Claim[];
}

export async function getClaim(projectId: string, claimId: string, options?: { signal?: AbortSignal }) {
  return api.get<Claim>(`/projects/${projectId}/claims/${claimId}`, options);
}

export async function createClaim(
  projectId: string,
  input: { statement: string; sourceUrl?: string; sourceName?: string },
) {
  return api.post<Claim>(`/projects/${projectId}/claims`, input);
}

/**
 * Approves a claim. This is a **hard gate**: an ungraded claim, or one whose
 * check result is a refusal, comes back 400 rather than being approved with a
 * caveat. The screen should not offer the control in those states.
 */
export async function approveClaim(projectId: string, claimId: string) {
  return api.post<Claim>(`/projects/${projectId}/claims/${claimId}/approve`);
}

/**
 * Attaches an external source. Two independent sources raise the grade to B
 * automatically — so this is the action that makes an ungradeable claim usable.
 */
export async function attachClaimSource(
  projectId: string,
  claimId: string,
  input: { name: string; url?: string },
) {
  return api.post<Claim>(`/projects/${projectId}/claims/${claimId}/sources`, input);
}

/** Re-runs the discipline check on a statement without persisting it. */
export async function checkClaimStatement(projectId: string, statement: string) {
  return api.post<{ checkResult: ClaimCheckResult; grade: ClaimGrade | null; gradeReason?: string }>(
    `/projects/${projectId}/claims/check`,
    { statement },
  );
}

/** Copy for a grade, and what it means. Shared so CL01 and CL02 agree. */
export const CLAIM_GRADE_LABEL: Record<ClaimGrade, string> = {
  A: 'Grade A — own measurement, n≥5',
  B: 'Grade B — two or more independent sources',
  C: 'Grade C — a single source',
};

export const CLAIM_CHECK_LABEL: Record<ClaimCheckResult, string> = {
  pending: 'Not checked yet',
  passed: 'Passed the discipline check',
  'banned-phrase': 'Blocked — banned phrase',
  'ungraded-number': 'Blocked — number without a grade',
  'single-run-rate': 'Blocked — rate from a single run',
};

/** True when the check result permanently blocks approval. */
export function isBlockingCheck(result: ClaimCheckResult): boolean {
  return result === 'banned-phrase' || result === 'ungraded-number' || result === 'single-run-rate';
}
