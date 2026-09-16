'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CheckCircle2, CircleAlert, ExternalLink, Info, Mail, RotateCcw, Send } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { ApiError } from '@/lib/api';
import { reportStatusLabel, reportStatusTone } from '@/lib/status-tones';
import {
  findReportRow,
  getReport,
  getReportLifecycle,
  listReportDeliveryAttempts,
  listReportRevisions,
  listReportShareLinks,
  recordReportDelivery,
  type ReportData,
  type ReportDeliveryAttempt,
  type ReportDeliveryChannel,
  type ReportLibraryRow,
  type ReportLifecycle,
  type ReportRevisionRow,
  type ReportShareLink,
} from '@/services/reports';

/**
 * RP05 — Report delivery.
 *
 * design_plan.md §4.4: *"Recipient, subject, correct accessible URL,
 * booking/testimonial options, send result"*. §5.10 steps 6–7 is the runbook:
 * choose the link **audience the recipient can actually open**, preview the
 * send, send as an explicit action, and report the result for what it is.
 *
 * Four rules are structural on this page, and they come from the shipped G05
 * endpoints rather than from copy:
 *
 *  1. **A send is an attempt, not a delivery** (§3.5, §5.10 step 7). The send
 *     result and the report's release state are rendered as two separate facts
 *     in two separate panels. `status: "sent"` is the provider **accepting**
 *     the message — there is no open or read tracking anywhere in this system,
 *     so nothing here claims the client saw it.
 *  2. **A failed send changes nothing.** It is a recorded outcome in the
 *     ledger, answered 200, and it never rolls back a release: the client can
 *     still read the report in their portal. That is stated, not implied.
 *  3. **Only a released report can be delivered at all.** The route refuses
 *     anything else with a 409, so an unreleased report renders an explicit
 *     precondition state naming the missing step instead of a form that would
 *     fail. There is no control here that would 409.
 *  4. **The audience choice is not a report-state change.** Sending does not
 *     release, publish or share anything; the visibility flag and the share
 *     links live on the review screen.
 *
 * The send ledger is the real one now (`GET :slug/delivery-attempts`): every
 * attempt, its channel, its recipient, its recorded error and the released
 * revision it pointed at.
 */

type Audience = 'portal' | 'public' | 'custom';

const CHANNEL_LABEL: Record<ReportDeliveryChannel, string> = {
  email: 'Email via the provider',
  'link-share': 'Link share (recorded)',
  manual: 'Manual (recorded)',
};

/**
 * What an attempt's status pill may say.
 *
 * `sent` is deliberately not "Delivered": for the `email` channel it is the
 * provider accepting the message, and for the other two it is the operator's
 * own record of having sent it outside Cailyx. Neither is a read receipt.
 */
function attemptStatusLabel(attempt: ReportDeliveryAttempt): string {
  switch (attempt.status) {
    case 'queued':
      return 'Attempted — outcome unknown';
    case 'sent':
      return attempt.channel === 'email' ? 'Provider accepted' : 'Recorded as sent';
    case 'failed':
      return 'Failed';
    default:
      return attempt.status;
  }
}

function attemptStatusTone(status: string): StatusTone {
  switch (status) {
    case 'sent':
      return 'info';
    case 'failed':
      return 'danger';
    case 'queued':
      // Written before the provider was called and never settled. That is an
      // unknown outcome, which is not the same as a failure.
      return 'unmeasured';
    default:
      return 'neutral';
  }
}

export default function ReportDeliveryPage() {
  const params = useParams<{ projectId: string; slug: string }>();
  const { projectId, slug } = params;

  const [report, setReport] = useState<ReportData | null>(null);
  const [lifecycle, setLifecycle] = useState<ReportLifecycle | null>(null);
  const [attempts, setAttempts] = useState<ReportDeliveryAttempt[] | null>(null);
  const [links, setLinks] = useState<ReportShareLink[] | null>(null);
  /** Revision metadata only — used to resolve an attempt's `revisionId` to a number. */
  const [revisions, setRevisions] = useState<ReportRevisionRow[]>([]);
  const [row, setRow] = useState<ReportLibraryRow | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const [origin, setOrigin] = useState('');

  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [channel, setChannel] = useState<ReportDeliveryChannel>('email');
  const [audience, setAudience] = useState<Audience>('portal');
  const [customUrl, setCustomUrl] = useState('');

  const [submitting, setSubmitting] = useState(false);
  /** The row the server wrote for the last attempt from this page. */
  const [lastAttempt, setLastAttempt] = useState<ReportDeliveryAttempt | null>(null);
  const [sendError, setSendError] = useState<ApiError | null>(null);

  useEffect(() => {
    // The recipient's link has to be absolute, so the origin is read from the
    // browser rather than assumed. It is available after mount only.
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [data, life] = await Promise.all([
          getReport(projectId, slug, { signal }),
          getReportLifecycle(projectId, slug, { signal }),
        ]);
        setReport(data);
        setLifecycle(life);
        // Seed the subject once, then leave it to the operator. This is
        // deliberately outside a per-keystroke refetch.
        setSubject((current) => current || `${data.title} — your AI visibility diagnostic`);

        try {
          setAttempts(await listReportDeliveryAttempts(projectId, slug, { signal }));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setAttempts(null);
        }

        try {
          setRevisions(await listReportRevisions(projectId, slug, { signal }));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setRevisions([]);
        }

        try {
          setLinks(await listReportShareLinks(projectId, slug, { signal }));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setLinks(null);
        }

        try {
          setRow(await findReportRow(projectId, slug, { signal }));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setRow(null);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, slug],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const releasedRevision = lifecycle?.releasedRevision ?? null;
  const isReleased = lifecycle?.status === 'released' && releasedRevision !== null;
  const isPublic = lifecycle?.visibility === 'public';

  const portalUrl = `${origin}/client/reports/${slug}`;
  const publicUrl = `${origin}/shared/reports/${projectId}/${slug}`;
  const liveShareLinks = useMemo(
    () =>
      (links ?? []).filter(
        (link) =>
          link.revokedAt === null &&
          (link.expiresAt === null || new Date(link.expiresAt) > new Date()),
      ),
    [links],
  );

  /** The link this attempt would send. Only the `email` channel sends one. */
  const chosenUrl =
    audience === 'portal' ? portalUrl : audience === 'public' ? publicUrl : customUrl.trim();

  const recipientLooksValid =
    channel === 'email'
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim())
      : recipient.trim().length > 0;

  const isAbsoluteHttpUrl = /^https?:\/\/\S+$/i.test(customUrl.trim());

  /** The mismatch that would waste the send: a public link that is not public. */
  const audienceBlocked = channel === 'email' && audience === 'public' && !isPublic;

  const blockingReasons = useMemo(() => {
    const reasons: string[] = [];
    if (!recipientLooksValid) {
      reasons.push(
        channel === 'email'
          ? 'A recipient email address is required: the email channel sends to it, and the server records it as the recipient.'
          : 'A recipient is required. For this channel it is the record of who you sent the report to, and it can be a name rather than an address.',
      );
    }
    if (channel === 'email' && audienceBlocked) {
      reasons.push(
        'The public link does not open yet: this report’s public-link flag is off, so an unauthenticated recipient would get a 404. Turn it on from the review screen, mint a share link there instead, or send the client-portal link.',
      );
    }
    if (channel === 'email' && audience === 'custom' && !isAbsoluteHttpUrl) {
      reasons.push(
        'Paste a full URL for the recipient to open — it has to start with http:// or https://, because the recipient is not you and the link is the whole delivery.',
      );
    }
    return reasons;
  }, [recipientLooksValid, channel, audienceBlocked, audience, isAbsoluteHttpUrl]);

  /**
   * A send that the provider accepted is not repeated by a second click.
   *
   * A **failed** attempt is deliberately retryable: nothing was delivered, so
   * a retry cannot duplicate anything, and forcing an edit before retrying
   * would be friction for its own sake (§10.4's guard is about duplicates).
   */
  const sentSuccessfully = lastAttempt !== null && lastAttempt.status !== 'failed';

  async function onSend() {
    if (!isReleased || submitting || blockingReasons.length > 0 || sentSuccessfully) return;

    setSubmitting(true);
    setSendError(null);
    try {
      const attempt = await recordReportDelivery(projectId, slug, {
        recipient: recipient.trim(),
        channel,
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        ...(channel === 'email' ? { reportUrl: chosenUrl } : {}),
      });
      setLastAttempt(attempt);
      // The ledger is server state; read it back rather than assuming the
      // row list in memory matches (§10.3).
      await load();
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setSendError(toApiError(caught));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const attemptColumns = useMemo<ColumnDef<ReportDeliveryAttempt>[]>(() => {
    // An attempt records the revision *id* it pointed at. Resolving that to a
    // number uses this report's own revision list, so the column can never
    // guess "revision N" from whatever happens to be released now.
    const revisionNumberById = new Map(revisions.map((r) => [r.id, r.revision]));
    return [
      {
        key: 'attemptedAt',
        header: 'Attempted',
        accessor: (a) => a.attemptedAt,
        sortable: true,
        render: (a) => <Timestamp value={a.attemptedAt} />,
      },
      {
        key: 'channel',
        header: 'Channel',
        accessor: (a) => a.channel,
        sortable: true,
        render: (a) => (
          <span>
            {CHANNEL_LABEL[a.channel as ReportDeliveryChannel] ?? a.channel}
          </span>
        ),
      },
      {
        key: 'recipient',
        header: 'Recipient',
        accessor: (a) => a.recipient,
        render: (a) => <span className="break-all">{a.recipient}</span>,
      },
      {
        key: 'status',
        header: 'Result',
        accessor: (a) => a.status,
        sortable: true,
        render: (a) => (
          <StatusPill label={attemptStatusLabel(a)} tone={attemptStatusTone(a.status)} />
        ),
      },
      {
        key: 'revisionId',
        header: 'Released revision',
        accessor: (a) => a.revisionId,
        render: (a) =>
          a.revisionId === null ? (
            <span className="text-muted-foreground">Not recorded</span>
          ) : (
            <span className="text-muted-foreground">
              {revisionNumberById.get(a.revisionId) !== undefined
                ? `Revision ${revisionNumberById.get(a.revisionId)}`
                : 'Revision id not in this report’s history'}
            </span>
          ),
      },
      {
        key: 'error',
        header: 'Recorded outcome',
        accessor: (a) => a.error,
        render: (a) =>
          a.status === 'failed' && a.error ? (
            <span className="break-words text-danger-foreground">{a.error}</span>
          ) : a.status === 'queued' ? (
            <span className="text-muted-foreground">
              Recorded before the send and never settled — the outcome is unknown, not failed.
            </span>
          ) : (
            <span className="text-muted-foreground">
              {a.channel === 'email'
                ? 'The provider accepted the message.'
                : 'Recorded by the operator; no provider was involved.'}
            </span>
          ),
      },
      {
        key: 'attemptedBy',
        header: 'Attempted by',
        accessor: (a) => a.attemptedBy,
        emptyLabel: 'Not recorded',
        render: (a) => (
          <span className="font-mono text-meta">{a.attemptedBy ?? 'Not recorded'}</span>
        ),
      },
    ];
  }, [revisions]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Deliver report" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!report || !lifecycle) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: row?.projectName ?? report.title,
          domain: report.targetUrl,
          mode: 'snapshot',
          snapshotLabel: `Prepared ${new Date(report.createdAt).toLocaleDateString()}`,
          runLabel: releasedRevision !== null ? `Released revision ${releasedRevision}` : undefined,
        }}
      />

      <PageHeader
        breadcrumbs={[
          { label: 'Reports', href: `/projects/${projectId}/reports` },
          { label: report.title, href: `/projects/${projectId}/reports/${slug}` },
          { label: 'Deliver' },
        ]}
        title="Deliver report"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{report.slug}</span>
            <span className="text-meta text-muted-foreground">
              Sending is an attempt. It does not change the report.
            </span>
          </span>
        }
        status={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={reportStatusLabel(lifecycle.status)}
              tone={reportStatusTone(lifecycle.status)}
            />
            {isPublic ? (
              <StatusPill label="Anyone with link" tone="warning" />
            ) : (
              <StatusPill label="No public link" tone="neutral" />
            )}
          </span>
        }
        secondaryActions={
          <span className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/reports/${slug}/review`}>
                Review &amp; release
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLastAttempt(null);
                void load();
              }}
            >
              <RotateCcw aria-hidden="true" className="mr-2 h-4 w-4" />
              Reload
            </Button>
          </span>
        }
      />

      {/* ── Fact one: the report's state. Independent of any send. ─────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Release state</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-table text-muted-foreground">
            These facts are about the report, not about the email below. A failed send does not
            change any of them, and nothing on this page rolls a report back.
          </p>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-meta text-muted-foreground">Editorial state</dt>
              <dd className="mt-1">
                <StatusPill
                  label={reportStatusLabel(lifecycle.status)}
                  tone={reportStatusTone(lifecycle.status)}
                />
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Released revision</dt>
              <dd className="mt-1 text-table">
                {releasedRevision !== null ? (
                  <span className="font-medium">Revision {releasedRevision}</span>
                ) : (
                  <span className="text-muted-foreground">Nothing is released.</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Released at</dt>
              <dd className="mt-1 text-table">
                {lifecycle.releasedAt ? (
                  <Timestamp value={lifecycle.releasedAt} />
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="text-meta text-muted-foreground">
            {isReleased ? (
              <>
                The client&apos;s portal is serving revision {releasedRevision} now, whether or not
                any email reaches them. That is what makes a failed send survivable.
              </>
            ) : (
              <>
                The client&apos;s portal does not serve this report at all, so there is nothing for a
                recipient to open yet.{' '}
                <Link
                  href={`/projects/${projectId}/reports/${slug}/review`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Review &amp; release it first
                </Link>
                .
              </>
            )}
          </p>
          <p className="text-meta text-muted-foreground">
            {isPublic
              ? 'A public URL exists for this report. It is a different axis from release — it is turned on and off on the review screen, and it is not what the client portal serves.'
              : 'No public URL exists. If the recipient has no client login, either send the client-portal link and arrange access, or mint a share link on the review screen.'}
          </p>
        </CardContent>
      </Card>

      {/* ── The precondition, stated instead of a form that would 409 ──── */}
      {!isReleased ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Send</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <EmptyState
              variant="not-measured"
              subject="a delivery for this report"
              prerequisite={`This report is "${lifecycle.status}" and no revision is released. The delivery route only accepts a released report — anything else is refused, because the recipient would be sent a link their portal will not open.`}
              action={{
                label: 'Review & release this report',
                href: `/projects/${projectId}/reports/${slug}/review`,
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Fact two: the send itself ─────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Send</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="recipient">
                  Recipient {channel === 'email' ? '(email address)' : ''}
                </Label>
                <Input
                  id="recipient"
                  name="recipient"
                  type={channel === 'email' ? 'email' : 'text'}
                  autoComplete="email"
                  value={recipient}
                  onChange={(event) => {
                    setRecipient(event.target.value);
                    setLastAttempt(null);
                  }}
                  aria-describedby="recipient-help"
                  aria-invalid={recipient.length > 0 && !recipientLooksValid ? true : undefined}
                />
                <p id="recipient-help" className="text-meta text-muted-foreground">
                  {channel === 'email'
                    ? 'Required, and it has to be an address for this channel: the server sends to it and records it as the recipient.'
                    : 'Required. The ledger records who the report was sent to, even though Cailyx is not the one sending it for this channel.'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="subject">Subject</Label>
                <Input
                  id="subject"
                  name="subject"
                  value={subject}
                  maxLength={300}
                  onChange={(event) => {
                    setSubject(event.target.value);
                    setLastAttempt(null);
                  }}
                  aria-describedby="subject-help"
                />
                <p id="subject-help" className="text-meta text-muted-foreground">
                  Editable before send, and recorded on the attempt. It is only used by the email
                  channel.
                </p>
              </div>

              <fieldset className="space-y-3">
                <legend className="text-table font-medium">Channel</legend>
                <p className="text-meta text-muted-foreground">
                  The channel decides what actually happens, so it is not a cosmetic choice. Only
                  the email channel reaches a provider; the other two record an attempt you made
                  yourself, and the ledger says which is which.
                </p>

                {(['email', 'link-share', 'manual'] as ReportDeliveryChannel[]).map((option) => (
                  <label
                    key={option}
                    className="flex cursor-pointer gap-3 rounded-lg border border-border p-3"
                  >
                    <input
                      type="radio"
                      name="channel"
                      value={option}
                      checked={channel === option}
                      onChange={() => {
                        setChannel(option);
                        setLastAttempt(null);
                      }}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block text-table font-medium">{CHANNEL_LABEL[option]}</span>
                      <span className="mt-1 block text-meta text-muted-foreground">
                        {option === 'email'
                          ? 'Cailyx sends the link through the configured email provider and records the provider’s answer. This is the only channel with a real send behind it.'
                          : option === 'link-share'
                            ? 'You sent a share link yourself, outside Cailyx. The ledger records that you did — “sent” here is your record, not a provider receipt.'
                            : 'You delivered the report some other way — a call, a portal walkthrough, an attachment. The ledger records that it happened.'}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {channel === 'email' ? (
                <fieldset className="space-y-3">
                  <legend className="text-table font-medium">
                    Which link the recipient gets
                  </legend>
                  <p className="text-meta text-muted-foreground">
                    This is the choice that decides whether the email is usable. An operator&apos;s
                    own preview URL is deliberately not an option — it is authenticated by a session
                    the recipient does not have.
                  </p>

                  <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
                    <input
                      type="radio"
                      name="audience"
                      value="portal"
                      checked={audience === 'portal'}
                      onChange={() => {
                        setAudience('portal');
                        setLastAttempt(null);
                      }}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block text-table font-medium">
                        Client portal link — requires a client sign-in
                      </span>
                      <span className="mt-0.5 block break-all font-mono text-meta text-muted-foreground">
                        {origin ? portalUrl : `/client/reports/${slug}`}
                      </span>
                      <span className="mt-1 block text-meta text-muted-foreground">
                        Readable only by a signed-in account for this client, and it keeps working
                        across future revisions. If the recipient has no login, this email will lead
                        them to a sign-in page they cannot pass.
                      </span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
                    <input
                      type="radio"
                      name="audience"
                      value="public"
                      checked={audience === 'public'}
                      onChange={() => {
                        setAudience('public');
                        setLastAttempt(null);
                      }}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block text-table font-medium">
                        Public link — anyone with the URL
                      </span>
                      <span className="mt-0.5 block break-all font-mono text-meta text-muted-foreground">
                        {origin ? publicUrl : `/shared/reports/${projectId}/${slug}`}
                      </span>
                      <span className="mt-1 block text-meta text-muted-foreground">
                        No sign-in at all. It only opens when this report&apos;s public-link flag is
                        on, and it is {isPublic ? 'on' : 'off'} right now. It follows the report
                        rather than a revision, and it cannot be revoked without turning the flag
                        off for everyone.
                      </span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
                    <input
                      type="radio"
                      name="audience"
                      value="custom"
                      checked={audience === 'custom'}
                      onChange={() => {
                        setAudience('custom');
                        setLastAttempt(null);
                      }}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-table font-medium">
                        A share link you already minted
                      </span>
                      <span className="mt-1 block text-meta text-muted-foreground">
                        Share links expire and revoke individually, which is why they are the better
                        answer outside the portal. Their raw token is shown once, on the review
                        screen, and cannot be read back afterwards — so paste the link you copied
                        there.
                      </span>
                      <span className="mt-2 block space-y-1.5">
                        <Label htmlFor="custom-url">Link the recipient will open</Label>
                        <Input
                          id="custom-url"
                          name="custom-url"
                          value={customUrl}
                          placeholder="https://…"
                          onChange={(event) => {
                            setCustomUrl(event.target.value);
                            setLastAttempt(null);
                          }}
                          aria-describedby="custom-url-help"
                          aria-invalid={
                            audience === 'custom' && customUrl.trim().length > 0 && !isAbsoluteHttpUrl
                              ? true
                              : undefined
                          }
                        />
                        <span id="custom-url-help" className="block text-meta text-muted-foreground">
                          Must be a full http(s) URL. Cailyx does not check that it resolves —
                          opening it yourself first is the only way to know the recipient can.
                        </span>
                      </span>
                    </span>
                  </label>
                </fieldset>
              ) : (
                <p className="text-meta text-muted-foreground">
                  No link is sent for this channel, so there is none to choose. The ledger records
                  the recipient, the channel and the time — not the URL you used.
                </p>
              )}

              <Separator />

              {/* §10.4 — preview the target and the effect before the explicit action. */}
              <div className="space-y-2">
                <div className="text-table font-medium">Preview</div>
                <dl className="space-y-1.5 text-table">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Channel:</dt>
                    <dd>{CHANNEL_LABEL[channel]}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">To:</dt>
                    <dd>{recipient.trim() || 'No recipient yet'}</dd>
                  </div>
                  {channel === 'email' ? (
                    <>
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-muted-foreground">Subject:</dt>
                        <dd>{subject.trim() || 'Your AI visibility report (provider default)'}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-muted-foreground">Link:</dt>
                        <dd className="break-all font-mono text-meta">
                          {chosenUrl || 'Resolving…'}
                        </dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-muted-foreground">Body:</dt>
                        <dd className="text-muted-foreground">
                          A single “Open your full report” link and an invitation to book a
                          walkthrough.
                        </dd>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="text-muted-foreground">Cailyx sends:</dt>
                      <dd className="text-muted-foreground">
                        Nothing. This records an attempt you are making yourself.
                      </dd>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Release state after this:</dt>
                    <dd className="text-muted-foreground">
                      Unchanged — revision {releasedRevision} stays released whatever the send
                      result is.
                    </dd>
                  </div>
                </dl>
              </div>

              {blockingReasons.length > 0 ? (
                <Alert>
                  <Mail aria-hidden="true" className="h-4 w-4 text-warning" />
                  <AlertTitle>This attempt would not work yet</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 pl-4">
                      {blockingReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void onSend()}
                  disabled={
                    submitting || blockingReasons.length > 0 || sentSuccessfully
                  }
                >
                  <Send aria-hidden="true" className="mr-2 h-4 w-4" />
                  {submitting
                    ? 'Sending…'
                    : channel === 'email'
                      ? 'Send the report link'
                      : 'Record this attempt'}
                </Button>
                {sentSuccessfully ? (
                  <span className="text-meta text-muted-foreground">
                    An attempt has already been recorded from this page. Change a field to clear
                    that and send again — a second click on an unchanged form is not offered.
                  </span>
                ) : (
                  <span className="text-meta text-muted-foreground">
                    Nothing is sent or recorded until you press this.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── The attempt's outcome, in its own words ─────────────────── */}
          {sendError ? (
            <ErrorState
              error={sendError}
              layout="inline"
              providerName="the email provider"
              onRetry={() => setSendError(null)}
              preserveNotice="Nothing was sent, and the report itself is unchanged — it is still readable wherever it was readable before this attempt."
            />
          ) : null}

          {lastAttempt ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">
                  {lastAttempt.status === 'failed'
                    ? 'The attempt failed'
                    : lastAttempt.status === 'queued'
                      ? 'The attempt was recorded but not settled'
                      : 'The attempt was recorded'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {lastAttempt.status === 'sent' ? (
                  <div className="flex items-start gap-2">
                    <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 text-info" />
                    <div>
                      <div className="text-table font-medium">
                        {lastAttempt.channel === 'email'
                          ? 'The email provider accepted the message'
                          : 'Recorded as sent by you'}
                      </div>
                      <p className="mt-1 text-table text-muted-foreground">
                        {lastAttempt.channel === 'email'
                          ? 'That is all this result establishes. It is not proof the message reached an inbox, and this system has no open or read tracking — so nobody can tell you the client has seen it.'
                          : 'This channel records an attempt you made outside Cailyx. There is no provider answer behind it, so it is your record rather than a receipt.'}
                      </p>
                    </div>
                  </div>
                ) : lastAttempt.status === 'queued' ? (
                  <div className="flex items-start gap-2">
                    <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 text-warning" />
                    <p className="text-table">
                      The attempt row was written before the send and never updated, so the outcome
                      is unknown — not failed. Check the ledger below before repeating it.
                    </p>
                  </div>
                ) : (
                  <div className="text-table">
                    <span className="font-medium text-danger-foreground">
                      The send did not succeed.
                    </span>{' '}
                    The report is still released: the client can read revision {releasedRevision} in
                    their portal exactly as before, and nothing about the report changed.
                    {lastAttempt.error ? (
                      <span className="mt-1 block text-muted-foreground">
                        The server recorded: {lastAttempt.error}
                      </span>
                    ) : null}
                  </div>
                )}

                <dl className="space-y-1.5 text-table">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Attempt id:</dt>
                    <dd className="font-mono text-meta">{lastAttempt.id}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Channel:</dt>
                    <dd>{CHANNEL_LABEL[lastAttempt.channel as ReportDeliveryChannel] ?? lastAttempt.channel}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Recipient:</dt>
                    <dd className="break-all">{lastAttempt.recipient}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Attempted:</dt>
                    <dd>
                      <Timestamp value={lastAttempt.attemptedAt} />
                    </dd>
                  </div>
                </dl>

                <p className="text-meta text-muted-foreground">
                  The report&apos;s release state is untouched by this attempt — see the panel at the
                  top of this page.
                </p>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      {/* ── The ledger ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Delivery attempts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-meta text-muted-foreground">
            Every recorded attempt, newest first, with the released revision it pointed at. “Sent”
            means the provider accepted the message — it is not a delivery, an open or a read, and
            no row here can tell you the client has seen the report.
          </p>
          {links !== null && liveShareLinks.length > 0 ? (
            <p className="text-meta text-muted-foreground">
              This report has {liveShareLinks.length} live share link
              {liveShareLinks.length === 1 ? '' : 's'}, which resolve to whatever revision is
              currently released. View counts there are requests, not reads.
            </p>
          ) : null}
          {attempts === null ? (
            <EmptyState
              variant="not-measured"
              subject="the delivery ledger for this report"
              prerequisite="The attempt list could not be read, so attempts may exist that are not shown here. That is a failed read, not an empty ledger — reload to try again."
            />
          ) : (
            <DataTable<ReportDeliveryAttempt>
              columns={attemptColumns}
              rows={attempts}
              getRowId={(a) => a.id}
              caption="Delivery attempts"
              ariaLabel="Delivery attempts"
              defaultSort={{ key: 'attemptedAt', direction: 'desc' }}
              minTableWidth="60rem"
              emptyState={
                <EmptyState
                  variant="not-measured"
                  subject="a delivery attempt for this report"
                  prerequisite={
                    isReleased
                      ? 'No attempt has been recorded. Nothing is sent or recorded until an operator sends it from this screen.'
                      : 'No attempt has been recorded, and none can be recorded while no revision is released. Attempts that were made before a withdrawal stay in this ledger.'
                  }
                />
              }
            />
          )}
          {attempts !== null && attempts.length > 0 ? (
            <Alert>
              <Info aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              <AlertDescription>
                A failed attempt is a fact about the email, not about the report: the ledger row is
                written either way and the release is never rolled back. Repeated failures mean the
                link or the recipient is wrong, not that the client lost access.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Sharing, which is not delivering</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-table text-muted-foreground">
            Two things on the review screen are easy to confuse with this one, and they are
            deliberately separate:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-table text-muted-foreground">
            <li>
              <strong className="font-medium text-foreground">Release</strong> is what puts the report
              in the client&apos;s portal. It is the precondition for everything on this page, and
              it sends nothing.
            </li>
            <li>
              <strong className="font-medium text-foreground">Public sharing</strong> — the public
              link flag and the expiring, revocable share links — governs who can read the report
              with no sign-in at all. Sending an email never turns either of them on.
            </li>
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/reports/${slug}/review`}>
                <ExternalLink aria-hidden="true" className="mr-2 h-4 w-4" />
                Open review &amp; release
              </Link>
            </Button>
            <span className="text-meta text-muted-foreground">
              Newer data does not change what a recipient reads: a released revision is frozen, and a
              new one is a separate version.
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
