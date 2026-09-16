'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Link2, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, WORK_STATUS_LABEL, workStatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { toViewWorkStatus } from '@/lib/work-mapping';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  getPortalPlan,
  listPortalWorkItems,
  splitWorkDescription,
  submitPortalEvidence,
  type PortalPlan,
  type PortalWorkItem,
} from '@/services/portal-plan';

/**
 * CP16 — Work handoff.
 *
 * design_plan.md §4.5: *"Implementation guidance, staging/live evidence,
 * dependency questions, mark ready for verification."*
 *
 * Two things shape every decision on this page:
 *
 *  1. **The evidence lines are parsed, not printed.** When work is submitted,
 *     the backend appends `[<label> <timestamp> by <userId>] <note> — <url>` to
 *     the work item's `description`. That `by <userId>` is a raw user
 *     identifier, and `toWorkItemDto({ includeInternal: false })` does not strip
 *     it. The parser in `services/portal-plan` removes it, and this page *says
 *     so* rather than silently rewriting the field.
 *  2. **The status is the gate.** The server only accepts client evidence on an
 *     item that is `active` and only from its assignee; a successful submission
 *     moves it to `review`. Rather than offer a control that would 403, the page
 *     shows the form when the item is active and explains the states where it is
 *     not — and it re-reads after submitting rather than assuming.
 *
 * There is no single-item portal route, so the item is read from the shared
 * work list and selected by id. An id that is not in that list is either not
 * this client's or not flagged client-visible; both render the same state.
 */
export default function ClientWorkDetailPage() {
  const params = useParams<{ projectId: string; workId: string }>();
  const { projectId, workId } = params;

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [item, setItem] = useState<PortalWorkItem | null | undefined>(undefined);
  const [plan, setPlan] = useState<PortalPlan | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [note, setNote] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, workItems, planResult] = await Promise.allSettled([
          listPortalProjectSummaries({ signal }),
          listPortalWorkItems(projectId, { signal }),
          getPortalPlan(projectId, { signal }),
        ]);
        if (projects.status === 'rejected') throw projects.reason;
        setProject(projects.value.find((entry) => entry.id === projectId) ?? null);

        if (workItems.status === 'rejected') {
          setItem(undefined);
          return;
        }
        setItem(workItems.value.find((entry) => entry.id === workId) ?? null);
        if (planResult.status === 'fulfilled') setPlan(planResult.value);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, workId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onSubmit() {
    if (!item) return;
    setBusy(true);
    setProblem(null);
    try {
      await submitPortalEvidence(projectId, item.id, {
        note: note.trim(),
        sourceUrl: sourceUrl.trim() || undefined,
      });
      setSent(true);
      setNote('');
      setSourceUrl('');
      await load();
    } catch (caught) {
      setProblem(
        caught instanceof Error
          ? caught.message
          : 'Your evidence could not be submitted. Nothing was changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Work item" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (project === undefined || item === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  if (project === null || item === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Work item" />
        <EmptyState
          variant="not-measured"
          subject="this work item"
          prerequisite="It is not one of the items shared with you on this project. Your delivery team decides what is visible here."
          action={{ label: 'Back to the plan', href: `/client/projects/${projectId}/plan` }}
        />
      </div>
    );
  }

  const parsed = splitWorkDescription(item.description);
  const viewStatus = toViewWorkStatus(item.status);
  const cycle = plan?.cycles.find((entry) => entry.id === item.cycleId) ?? null;
  const dependencies = item.dependsOn.map((id) => ({
    id,
    visible: plan?.workItems.find((candidate) => candidate.id === id) ?? null,
  }));

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Plan', href: `/client/projects/${projectId}/plan` },
          { label: item.title },
        ]}
        title={item.title}
        context={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{humanize(item.discipline)}</span>
            {cycle ? <span>{cycle.name}</span> : null}
            {item.dueAt ? (
              <span>
                Due <Timestamp value={item.dueAt} dateOnly />
              </span>
            ) : (
              <span className="text-muted-foreground">No due date set</span>
            )}
          </span>
        }
        status={<StatusPill label={WORK_STATUS_LABEL[viewStatus]} tone={workStatusTone(viewStatus)} />}
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/client/projects/${projectId}/plan`}>
              <ArrowLeft aria-hidden="true" className="mr-2 h-4 w-4" />
              Back to the plan
            </Link>
          </Button>
        }
      />

      {/* ── How this is going ──────────────────────────────────────────── */}
      {item.status === 'blocked' ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>This is blocked</AlertTitle>
          <AlertDescription>
            <p>{item.blockedReason ?? 'No reason was recorded for this blocker.'}</p>
            {item.blockedOn ? <p>Waiting on: {item.blockedOn}</p> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {item.status === 'review' && !sent ? (
        <Alert>
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Submitted — waiting to be verified</AlertTitle>
          <AlertDescription>
            Your evidence is recorded against this item. Verification is your
            delivery team&apos;s step, and a rejected submission reopens the item
            rather than closing it.
          </AlertDescription>
        </Alert>
      ) : null}

      {sent ? (
        <Alert role="status">
          <AlertTitle>Evidence recorded</AlertTitle>
          <AlertDescription>
            What you submitted is now on this item and it has moved to review.
            Verification is your delivery team&apos;s step, and a rejected
            submission reopens the item rather than closing it.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── Implementation guidance ────────────────────────────────────── */}
      <section aria-labelledby="guidance-heading" className="space-y-3">
        <h2 id="guidance-heading" className="text-subsection font-semibold tracking-tight">
          What to do
        </h2>
        <Card>
          <CardContent className="space-y-3 py-4">
            {parsed.guidance ? (
              <div className="whitespace-pre-wrap text-body leading-relaxed">{parsed.guidance}</div>
            ) : (
              <p className="text-table text-muted-foreground">
                No written guidance is attached to this work item. Ask your
                delivery team in{' '}
                <Link href="/client/messages" className="text-primary underline underline-offset-4">
                  messages
                </Link>{' '}
                if anything is unclear.
              </p>
            )}

            <dl className="grid gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-2">
              <div>
                <dt className="text-meta text-muted-foreground">Category</dt>
                <dd className="text-table">{humanize(item.category)}</dd>
              </div>
              <div>
                <dt className="text-meta text-muted-foreground">Last updated</dt>
                <dd className="text-table">
                  <Timestamp value={item.updatedAt} />
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* ── Evidence ───────────────────────────────────────────────────── */}
      <section aria-labelledby="evidence-heading" className="space-y-3">
        <h2 id="evidence-heading" className="text-subsection font-semibold tracking-tight">
          Staging and live evidence
        </h2>
        <Card>
          <CardContent className="space-y-3 py-4">
            {parsed.entries.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="evidence for this item"
                prerequisite="Nothing has been submitted yet. Evidence appears here once somebody records what was done, with the URL it can be seen at."
              />
            ) : (
              <ul className="divide-y divide-border">
                {parsed.entries.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className="space-y-1 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                      <span className="font-medium text-foreground">{entry.label}</span>
                      {entry.at ? <Timestamp value={entry.at} /> : null}
                    </div>
                    {entry.note ? (
                      <p className="whitespace-pre-wrap text-table">{entry.note}</p>
                    ) : null}
                    {entry.sourceUrl ? (
                      isSafeHref(entry.sourceUrl) ? (
                        <a
                          href={entry.sourceUrl}
                          className="inline-flex items-center gap-1 text-table text-primary underline underline-offset-4"
                          {...(entry.sourceUrl.startsWith('/')
                            ? {}
                            : { target: '_blank', rel: 'noreferrer noopener' })}
                        >
                          <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
                          {entry.sourceUrl}
                        </a>
                      ) : (
                        <p className="text-meta text-muted-foreground">
                          {entry.sourceUrl}{' '}
                          <span>(not shown as a link: unsupported URL scheme)</span>
                        </p>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {parsed.redactedActor ? (
              <p className="text-meta text-muted-foreground">
                Evidence lines are written with the submitting person’s internal
                identifier. That identifier is removed from the text above —
                this screen does not show user ids — and it is the only edit made
                to what was recorded.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </section>

      {/* ── Dependency questions ───────────────────────────────────────── */}
      <section aria-labelledby="dependencies-heading" className="space-y-3">
        <h2 id="dependencies-heading" className="text-subsection font-semibold tracking-tight">
          What this depends on
        </h2>
        <Card>
          <CardContent className="space-y-3 py-4">
            {dependencies.length === 0 ? (
              <p className="text-table text-muted-foreground">
                This item does not wait on anything else.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {dependencies.map((dependency) => (
                  <li key={dependency.id} className="py-3">
                    {dependency.visible ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-table">{dependency.visible.title}</span>
                        <span className="flex items-center gap-2">
                          <StatusPill
                            label={WORK_STATUS_LABEL[toViewWorkStatus(dependency.visible.status)]}
                            tone={workStatusTone(toViewWorkStatus(dependency.visible.status))}
                          />
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/client/projects/${projectId}/work/${dependency.visible.id}`}>
                              Open
                            </Link>
                          </Button>
                        </span>
                      </div>
                    ) : (
                      <p className="text-table text-muted-foreground">
                        This waits on another piece of work your delivery team is
                        tracking. It is not shared with you, so it cannot be shown
                        here — ask in messages if you need to know what it is.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {item.blockedOn ? (
              <p className="text-table">
                <span className="text-muted-foreground">Waiting on:</span> {item.blockedOn}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </section>

      {/* ── Mark ready for verification ────────────────────────────────── */}
      <section aria-labelledby="submit-heading" className="space-y-3">
        <h2 id="submit-heading" className="text-subsection font-semibold tracking-tight">
          Mark ready for verification
        </h2>
        <Card>
          <CardContent className="space-y-4 py-4">
            {item.status === 'active' ? (
              <>
                <p className="text-table text-muted-foreground">
                  Record what you did — and, where it can be seen, the URL. This
                  moves the item to review; your delivery team then verifies it.
                </p>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="evidence-note">What you did</Label>
                    <Textarea
                      id="evidence-note"
                      value={note}
                      rows={3}
                      required
                      aria-describedby="evidence-note-help"
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <p id="evidence-note-help" className="text-meta text-muted-foreground">
                      Required. Plain text; it is recorded against this item.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="evidence-url">Where it can be seen (optional)</Label>
                    <Input
                      id="evidence-url"
                      type="url"
                      inputMode="url"
                      placeholder="https://www.example.com/page"
                      value={sourceUrl}
                      onChange={(event) => setSourceUrl(event.target.value)}
                    />
                    <p className="text-meta text-muted-foreground">
                      A staging or live URL. Anything that is not an http(s) link
                      is kept as text rather than turned into a link.
                    </p>
                  </div>
                </div>
                {problem ? (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{problem}</AlertDescription>
                  </Alert>
                ) : null}
                <Button size="sm" disabled={busy || note.trim() === ''} onClick={() => void onSubmit()}>
                  {busy ? 'Submitting…' : 'Submit for verification'}
                </Button>
                <p className="text-meta text-muted-foreground">
                  Only the person this item is assigned to can submit evidence
                  for it — if that is not you, the submission is refused rather
                  than recorded.
                </p>
              </>
            ) : item.status === 'review' || item.status === 'verified' ? (
              <p className="text-table text-muted-foreground">
                This item has already been submitted, so there is nothing to send.
                {item.status === 'review'
                  ? ' It is waiting to be verified.'
                  : ' It has been verified.'}
              </p>
            ) : item.status === 'blocked' ? (
              <p className="text-table text-muted-foreground">
                Evidence can be submitted once the blocker above is cleared and
                the item is active again.
              </p>
            ) : item.status === 'cancelled' ? (
              <p className="text-table text-muted-foreground">
                This item was cancelled, so there is nothing to implement.
              </p>
            ) : (
              <p className="text-table text-muted-foreground">
                This item has not been started yet, so evidence cannot be
                submitted. It becomes available once the work is active.
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/** Only `http(s)` and same-origin-relative links are rendered as links (§10.5). */
function isSafeHref(href: string): boolean {
  if (href.startsWith('/')) return true;
  try {
    const url = new URL(href, 'https://cailyx.invalid');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function humanize(value: string): string {
  if (!value) return 'Work';
  return value.charAt(0).toUpperCase() + value.slice(1);
}
