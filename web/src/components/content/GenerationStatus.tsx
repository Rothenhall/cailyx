'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  isTerminalJobStatus,
  listGenerationJobs,
  retryGenerationJob,
  type GenerationJob,
  type GenerationJobStatus,
} from '@/services/content-generation';

/**
 * §13.7's persistent inline status.
 *
 * The whole point of this component is that it holds **no** job state of its
 * own. It re-reads the server's job ledger, so:
 *
 *  - closing the dialog loses nothing (the job was already accepted server-side),
 *  - a browser reload or an expired session finds the same jobs,
 *  - and a second tab sees the same status rather than a different one.
 *
 * It polls only while something is actually in flight, and stops at a terminal
 * status — a job that is queued with an unreachable queue stays visibly queued
 * rather than being retried on a timer (retrying a stalled *queue* is a
 * different act from retrying a failed *job*, and it is a deliberate button).
 */
export function GenerationStatus({
  projectId,
  refreshKey,
  limit = 5,
}: {
  projectId: string;
  /** Bump to re-read immediately after a new job is accepted. */
  refreshKey?: number;
  limit?: number;
}) {
  const [jobs, setJobs] = useState<GenerationJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await listGenerationJobs(projectId, { limit }, { signal });
        setJobs(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        // A failed status read must not look like "no jobs" — that would hide
        // work in progress (§10.2). It says so instead.
        setError(caught instanceof Error ? caught.message : 'The generation status could not be read.');
      }
    },
    [projectId, limit],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  const hasActive = (jobs ?? []).some((job) => !isTerminalJobStatus(job.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const retry = useCallback(
    async (jobId: string) => {
      setBusyId(jobId);
      try {
        await retryGenerationJob(projectId, jobId);
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'The retry could not be started.');
      } finally {
        setBusyId(null);
      }
    },
    [projectId, load],
  );

  const visible = (jobs ?? []).filter((job) => !dismissed.includes(job.id));
  if (error === null && (jobs === null || visible.length === 0)) return null;

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-subsection font-medium text-foreground">
          Being prepared
          {hasActive ? <Loader2 aria-hidden="true" className="ml-2 inline h-4 w-4 animate-spin" /> : null}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="text-table text-warning-foreground">
          <AlertTriangle aria-hidden="true" className="mr-2 inline h-4 w-4" />
          {error}
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {visible.map((job) => (
          <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div className="min-w-0">
              <p className="text-table text-foreground">
                {job.assetType.replace(/-/g, ' ')}
                {job.briefId ? ` · plan ${job.briefId.slice(0, 6)}… v${job.briefVersion ?? '?'}` : ' · no plan'}
              </p>
              <p className="text-meta text-muted-foreground">
                Requested <Timestamp value={job.createdAt} />
                {job.status === 'failed' && job.error ? ` · ${job.error}` : ''}
                {job.status === 'queued' && job.attempts === 0
                  ? ' · waiting for the queue — this is not a failure'
                  : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill label={JOB_LABELS[job.status]} tone={JOB_TONES[job.status]} />
              {job.status === 'succeeded' && job.contentAssetId ? (
                <Link
                  href={`/projects/${projectId}/content/${job.contentAssetId}`}
                  className="text-table text-primary underline-offset-4 hover:underline"
                >
                  Open the draft
                </Link>
              ) : null}
              {job.status === 'failed' && job.attempts < job.maxAttempts ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void retry(job.id)}
                  disabled={busyId === job.id}
                >
                  {busyId === job.id ? 'Retrying…' : `Retry (${job.maxAttempts - job.attempts} left)`}
                </Button>
              ) : null}
              {isTerminalJobStatus(job.status) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Hide this job from the status list"
                  onClick={() => setDismissed((current) => [...current, job.id])}
                >
                  <XCircle aria-hidden="true" className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const JOB_LABELS: Record<GenerationJobStatus, string> = {
  queued: 'Queued',
  running: 'Preparing',
  succeeded: 'Draft ready',
  partial: 'Partly ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const JOB_TONES: Record<GenerationJobStatus, StatusTone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};
