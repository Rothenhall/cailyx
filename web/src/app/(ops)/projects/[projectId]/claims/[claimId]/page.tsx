'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  CLAIM_CHECK_LABEL,
  CLAIM_GRADE_LABEL,
  approveClaim,
  attachClaimSource,
  getClaim,
  isBlockingCheck,
  type Claim,
} from '@/services/claims';

/**
 * CL02 — Claim detail and check.
 *
 * design_plan.md §4.4: *"Statement, exact evidence, source independence,
 * discipline violations, grade r…"*
 *
 * The screen is organised around one question: **what would it take to make
 * this statement publishable?** So the discipline result is the headline, not a
 * footnote, and the two ways forward — attach an independent source, or fix the
 * statement — are the only actions offered.
 *
 * Two rules are enforced here rather than left to the reader:
 *
 *  1. **A blocking check result is not advice.** `banned-phrase`,
 *     `ungraded-number` and `single-run-rate` cannot be approved, so the
 *     approve control is **absent** in those states with the reason stated —
 *     never a button that returns 400.
 *  2. **An ungraded claim cannot be approved either.** The grade is what makes
 *     a statement defensible; approving without one is the thing the module
 *     exists to prevent. `grade === null` disables the action and says why.
 *
 * What this screen deliberately does **not** do is judge source independence
 * itself. That is the discipline engine's job, it is recorded server-side, and
 * a UI that re-derived it would be a second opinion nobody asked for.
 */
export default function ClaimDetailPage() {
  const params = useParams<{ projectId: string; claimId: string }>();
  const { projectId, claimId } = params;

  const [claim, setClaim] = useState<Claim | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);

  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setClaim(await getClaim(projectId, claimId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, claimId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onApprove() {
    setBusy(true);
    setActionError(null);
    try {
      await approveClaim(projectId, claimId);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'The claim could not be approved.');
    } finally {
      setBusy(false);
    }
  }

  async function onAttachSource(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceName.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await attachClaimSource(projectId, claimId, {
        name: sourceName.trim(),
        url: sourceUrl.trim() || undefined,
      });
      setSourceName('');
      setSourceUrl('');
      await load();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The source could not be attached.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Claim" />
        <ErrorState
          error={error}
          onRetry={() => void load()}
          notFoundReason="missing-or-private"
        />
      </div>
    );
  }

  if (!claim) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const blocking = isBlockingCheck(claim.checkResult);
  const canApprove = !blocking && claim.grade !== null && claim.status !== 'approved';

  /** Why approve is unavailable, in the order the reader should care about. */
  const approveBlockedReason = blocking
    ? `${CLAIM_CHECK_LABEL[claim.checkResult]}. A claim in this state cannot be approved — the statement itself has to change, or the evidence behind it.`
    : claim.grade === null
      ? 'This claim has no grade yet. Attach a source or run the discipline check before approving it.'
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Claims', href: `/projects/${projectId}/claims` },
          { label: 'Claim' },
        ]}
        title={claim.statement}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={claim.status === 'approved' ? 'Approved' : claim.status === 'blocked' ? 'Blocked' : 'Draft'}
              tone={claim.status === 'approved' ? 'success' : claim.status === 'blocked' ? 'danger' : 'unmeasured'}
            />
            <StatusPill
              label={CLAIM_CHECK_LABEL[claim.checkResult]}
              tone={claim.checkResult === 'passed' ? 'success' : blocking ? 'danger' : 'warning'}
            />
          </span>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {/* A refusal is the most important thing on the page, so it leads. */}
      {blocking ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>This claim is blocked by the discipline check</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{CLAIM_CHECK_LABEL[claim.checkResult]}.</p>
            <p className="text-meta">
              This is a refusal, not a caution — the claim cannot be approved in
              this state. Rewrite the statement, or attach the evidence the check
              is asking for.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-subsection">Exact evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-table">
            <div>
              <div className="text-meta text-muted-foreground">Statement</div>
              <p className="mt-1 whitespace-pre-wrap">{claim.statement}</p>
            </div>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-meta text-muted-foreground">Source</div>
                <div className="mt-1">
                  {claim.sourceUrl ? (
                    <a
                      href={claim.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-primary underline underline-offset-4"
                    >
                      {claim.sourceName ?? claim.sourceUrl}
                    </a>
                  ) : claim.sourceName ? (
                    claim.sourceName
                  ) : (
                    <span className="text-muted-foreground">No source attached</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-meta text-muted-foreground">Grade</div>
                <div className="mt-1">
                  {claim.grade ? (
                    <span title={CLAIM_GRADE_LABEL[claim.grade]}>
                      <span className="font-semibold">{claim.grade}</span>
                      <span className="ml-2 text-meta text-muted-foreground">
                        {CLAIM_GRADE_LABEL[claim.grade]}
                      </span>
                    </span>
                  ) : (
                    <span className="text-unmeasured-foreground">Ungraded</span>
                  )}
                </div>
              </div>
            </div>
            {claim.gradeReason ? (
              <p className="text-meta text-muted-foreground">{claim.gradeReason}</p>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Decision</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {canApprove ? (
                <Button className="w-full" disabled={busy} onClick={() => setConfirmApprove(true)}>
                  <ShieldCheck aria-hidden="true" className="mr-2 h-4 w-4" />
                  Approve claim
                </Button>
              ) : claim.status === 'approved' ? (
                <p className="flex items-center gap-2 text-table text-success-foreground">
                  <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                  Approved
                </p>
              ) : (
                <p className="text-table text-muted-foreground">
                  {approveBlockedReason ?? 'Approval is not available for this claim.'}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Attach a source</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={onAttachSource} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="source-name">Source name</Label>
                  <Input
                    id="source-name"
                    value={sourceName}
                    onChange={(event) => setSourceName(event.target.value)}
                    placeholder="e.g. Gartner 2026 report"
                    required
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="source-url">URL</Label>
                  <Input
                    id="source-url"
                    type="url"
                    value={sourceUrl}
                    onChange={(event) => setSourceUrl(event.target.value)}
                    placeholder="https://…"
                    disabled={busy}
                  />
                </div>
                <Button type="submit" variant="outline" size="sm" disabled={busy || !sourceName.trim()}>
                  Attach source
                </Button>
                <p className="text-meta text-muted-foreground">
                  Two independent sources raise this claim to grade B automatically.
                  Independence is judged by the discipline engine, not by this screen.
                </p>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* The raw check payload, escaped. §10.5 — evidence is never markup. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Check detail</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-meta text-muted-foreground">
            The discipline engine&rsquo;s own output, as recorded.{' '}
            <Timestamp value={claim.updatedAt} /> · added <Timestamp value={claim.createdAt} dateOnly />
          </p>
          <pre className="evidence max-h-72 overflow-auto rounded-md border border-border bg-surface-sunken p-3">
            {formatCheckJson(claim.checkJson)}
          </pre>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={setConfirmApprove}
        title="Approve this claim?"
        targetLabel="Claim"
        target={claim.statement.length > 80 ? `${claim.statement.slice(0, 80)}…` : claim.statement}
        confirmLabel="Approve claim"
        effect="The claim becomes available as an approved, grade-backed assertion. An edit to the statement later does not carry this approval with it."
        onConfirm={onApprove}
        onConfirmed={() => setConfirmApprove(false)}
      />
    </div>
  );
}

/**
 * Pretty-prints the stored check JSON.
 *
 * Falls back to the raw string rather than to `{}` when it does not parse: a
 * payload that failed to parse is itself evidence something is wrong, and
 * hiding it behind an empty object would erase that.
 */
function formatCheckJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
