import { api, unwrap } from '@/lib/api';

/**
 * Durable generation adapters — P09 (platform_improvement_plan.md §13.6, §13.7).
 *
 * §13.7 is what makes this a *job* API rather than a "generate" call, and two
 * consequences show up in the function signatures below:
 *
 *  1. **POST returns an accepted job identity promptly.** `enqueueGenerationJob`
 *     resolves once the server has persisted the work (idempotency key, pinned
 *     brief/style/business-profile versions, target), not once the article
 *     exists. The dialog can close on that response — the result is found
 *     later by {@link getGenerationJob}, which survives a browser reload or a
 *     session expiry because none of the state is in the browser.
 *  2. **A retry is idempotent, not a re-run.** `retryGenerationJob` returns
 *     `requeued: false` and the existing revision when the job already
 *     succeeded — the concrete guard against a worker that crashed after
 *     writing the revision but before acknowledging it.
 *
 * §13.6's other rule is enforced by omission: nothing here accepts a model
 * name, a temperature, a token budget or a prompt-matrix id. Those are not
 * fields on the request, so no screen can offer them to a client by accident.
 */

export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface GenerationJob {
  id: string;
  projectId: string;
  status: GenerationJobStatus;
  assetType: string;
  /** The piece this job revises; null when the job creates a new piece. */
  contentAssetId: string | null;
  briefId: string | null;
  briefVersion: number | null;
  writingStyleProfileId: string | null;
  writingStyleVersion: number | null;
  writingStyleFingerprint: string | null;
  businessProfileVersion: number | null;
  attempts: number;
  maxAttempts: number;
  /** Set when the job produced a revision — the canonical destination (§13.7). */
  revisionId: string | null;
  error: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationTopicInput {
  targetKeyword: string;
  blogTopic?: string;
  adAngle?: string;
  searchVolume?: number;
}

export interface CreateGenerationJobInput {
  /** Client-supplied dedupe key. A resubmit with the same key returns the existing job (§13.7). */
  idempotencyKey: string;
  /**
   * A tracked asset type. Only types whose capability row says
   * `generationImplemented` are accepted — the server refuses the rest with a
   * specific 422 naming the type, so this is never a whitelist the frontend
   * keeps in step by hand.
   */
  assetType: string;
  /** Omit to create a new piece; set to add a revision to an existing one. */
  contentAssetId?: string;
  /** An approved brief. The server refuses a non-approved one rather than bypassing the gate. */
  briefId?: string;
  topic: GenerationTopicInput;
  /** Pin an exact confirmed style version. Omit to pin the active confirmed one at enqueue time. */
  writingStyleProfileId?: string;
  sourceEvidenceIds?: string[];
}

/** A stable, client-side idempotency key for one enqueue intent. */
export function newGenerationKey(): string {
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueGenerationJob(
  projectId: string,
  input: CreateGenerationJobInput,
): Promise<{ job: GenerationJob; created: boolean }> {
  return api.post<{ job: GenerationJob; created: boolean }>(
    `/projects/${projectId}/content-generation/jobs`,
    input,
  );
}

/**
 * Recent jobs for one project, newest first.
 *
 * This is what makes the inline status survive a reload (§13.7): the browser
 * re-reads the ledger instead of replaying a client-side list, so a job
 * accepted in another tab, on another device, or before a session expired is
 * still found — and never restarted.
 */
export async function listGenerationJobs(
  projectId: string,
  query: { status?: GenerationJobStatus; limit?: number } = {},
  options?: { signal?: AbortSignal },
): Promise<GenerationJob[]> {
  const payload = await api.get<{ jobs: GenerationJob[] }>(
    `/projects/${projectId}/content-generation/jobs`,
    { ...options, query: { status: query.status, limit: query.limit } },
  );
  return unwrap<GenerationJob[]>(payload, 'jobs');
}

export async function getGenerationJob(
  projectId: string,
  jobId: string,
  options?: { signal?: AbortSignal },
): Promise<GenerationJob> {
  return api.get<GenerationJob>(`/projects/${projectId}/content-generation/jobs/${jobId}`, options);
}

export async function retryGenerationJob(
  projectId: string,
  jobId: string,
): Promise<{ job: GenerationJob; requeued: boolean }> {
  return api.post<{ job: GenerationJob; requeued: boolean }>(
    `/projects/${projectId}/content-generation/jobs/${jobId}/retry`,
  );
}

export async function cancelGenerationJob(
  projectId: string,
  jobId: string,
): Promise<GenerationJob> {
  return api.post<GenerationJob>(`/projects/${projectId}/content-generation/jobs/${jobId}/cancel`);
}

/** The statuses that mean "nothing further will happen on its own" — polling stops here. */
export const TERMINAL_JOB_STATUSES: readonly GenerationJobStatus[] = [
  'succeeded',
  'partial',
  'failed',
  'cancelled',
];

export function isTerminalJobStatus(status: GenerationJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export const JOB_STATUS_LABELS: Record<GenerationJobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Ready',
  partial: 'Partly ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
