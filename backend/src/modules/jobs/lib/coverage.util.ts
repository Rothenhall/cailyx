/**
 * Run status and coverage, derived from a run's steps.
 *
 * This is the file that makes `partial` a real status rather than a synonym
 * for `failed` (G07 requirement 4): three of five engines answering is
 * `partial` — neither `completed` (the work is not all there) nor `failed`
 * (the work is not all missing). Both facts are stated, never averaged into
 * a single number that hides which engines were silent.
 *
 * @module jobs/lib/coverage.util
 */

import { JobCoverage, JobRunStatus, JobStepDto, JobStepStatus } from '../jobs.types';

/** The minimal step shape these calculations need. */
export interface StepLike {
  status: string;
  attempted: number;
  succeeded: number;
}

/**
 * Run status implied by its steps, or `null` when the steps say nothing
 * (an empty run) and the stored status should stand.
 *
 * Rules, in order:
 * - anything still running, or pending behind a settled step, means `running`;
 * - nothing started at all means `queued`;
 * - no failure but every step skipped means the run produced **nothing** —
 *   reported as `failed` (with the skip reason recorded on the run), never
 *   as `completed`;
 * - no failure and every step succeeded means `completed`;
 * - no step succeeded means `failed`;
 * - otherwise `partial`.
 */
export function deriveStatusFromSteps(steps: StepLike[]): JobRunStatus | null {
  if (steps.length === 0) return null;

  const count = (status: JobStepStatus) => steps.filter((s) => s.status === status).length;
  const pending = count('pending');
  const running = count('running');
  const succeeded = count('succeeded');
  const failed = count('failed');
  const skipped = count('skipped');
  const settled = succeeded + failed + skipped;

  if (running > 0 || (pending > 0 && settled > 0)) return 'running';
  if (pending > 0) return 'queued';
  if (failed === 0 && skipped === steps.length) return 'failed';
  if (failed === 0) return 'completed';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

/**
 * The coverage disclosure for a run's steps: how many steps settled, how many
 * items were attempted versus answered, and a plain sentence for the case
 * where those two numbers disagree.
 */
export function computeCoverage(steps: StepLike[]): JobCoverage {
  const count = (status: JobStepStatus) => steps.filter((s) => s.status === status).length;
  const succeeded = count('succeeded');
  const failed = count('failed');
  const skipped = count('skipped');
  const pending = count('pending');
  const running = count('running');
  const attemptedItems = steps.reduce((sum, s) => sum + (s.attempted ?? 0), 0);
  const succeededItems = steps.reduce((sum, s) => sum + (s.succeeded ?? 0), 0);

  let disclosure: string | null = null;
  if (steps.length > 0 && (failed > 0 || skipped > 0 || pending > 0 || running > 0)) {
    const parts: string[] = [`${succeeded} of ${steps.length} steps succeeded`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (running > 0) parts.push(`${running} still running`);
    if (pending > 0) parts.push(`${pending} not started`);
    disclosure = `${parts.join(', ')} — results are partial coverage, not a complete picture.`;
  }
  if (attemptedItems > succeededItems) {
    const gap = `${succeededItems} of ${attemptedItems} items returned a result`;
    disclosure = disclosure ? `${disclosure} ${gap}.` : `${gap} — partial coverage.`;
  }

  return {
    settled: succeeded + failed + skipped,
    total: steps.length,
    succeeded,
    failed,
    skipped,
    pending,
    running,
    attemptedItems,
    succeededItems,
    disclosure,
  };
}

/** Steps as the API returns them, oldest position first. */
export function toStepDtos(steps: Array<{
  id: string;
  name: string;
  position: number;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  attempted: number;
  succeeded: number;
  error: string | null;
  costUsd: number;
}>): JobStepDto[] {
  return steps
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      status: s.status as JobStepStatus,
      startedAt: s.startedAt ? s.startedAt.toISOString() : null,
      finishedAt: s.finishedAt ? s.finishedAt.toISOString() : null,
      attempted: s.attempted,
      succeeded: s.succeeded,
      error: s.error,
      costUsd: s.costUsd,
    }));
}
