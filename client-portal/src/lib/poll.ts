/**
 * Poll a status-fetching function on an interval until it reports a terminal
 * state. Ported from frontend/src/lib/poll-job.ts — same pattern, used here
 * for a client's project onboardingStatus ("pending"|"running"|"completed"|"failed").
 *
 * @module lib/poll
 */
export async function pollUntilDone<T extends { status: string }>(
  fetchStatus: () => Promise<T>,
  opts: {
    isDone?: (result: T) => boolean;
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (result: T) => void;
  } = {},
): Promise<T> {
  const isDone = opts.isDone ?? ((r: T) => r.status === 'completed' || r.status === 'failed');
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await fetchStatus();
    opts.onUpdate?.(result);
    if (isDone(result)) return result;
    if (Date.now() > deadline) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
