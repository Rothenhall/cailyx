'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ExternalLink,
  Mail,
  MousePointerClick,
  RefreshCw,
  ShieldAlert,
  TicketCheck,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  UPGRADE_TIERS,
  issueUpgrade,
  listLeadRows,
  listUpgrades,
  markUpgradeClicked,
  sendHandoffEmail,
  type Lead,
  type Upgrade,
  type UpgradeTier,
} from '@/services/sales';

/**
 * SL06 — Offers and upgrades.
 *
 * design_plan.md §4.2: *"Full/monitoring checkout links, issued/clicked/
 * completed ledger, send handoff."*
 *
 * ## A click is not a purchase, and the ledger is not a payment record
 *
 * §5.11 draws the line this screen is built around:
 *
 * > *"The public completion endpoint is an unsigned stand-in, not a verified
 * > payment event. Never let a browser callback, button, or ledger status alone
 * > grant service entitlements. Verified webhook handling and a billing model
 * > are G16."*
 *
 * Three consequences, all structural:
 *
 *  - The three states are rendered as a **timeline of three facts** (issued,
 *    clicked, completed), not as one dominant status word. `clicked` is
 *    labelled as a click, and `completed` is labelled with who recorded it.
 *  - There is **no control to mark an upgrade completed**. The route that does
 *    that is unauthenticated and stands in for a payment webhook; a button here
 *    would make a browser click the thing that grants a paid entitlement.
 *  - The ledger is presented as a record of what was issued and what was
 *    observed, explicitly **not** as the authority on whether a customer has
 *    paid. The billing model that would settle that is G16.
 *
 * ## What "send handoff" is
 *
 * The handoff email is the one outbound send the delivery module offers: a
 * report link plus a booking CTA. Its result means the provider **accepted**
 * the message, which §5.10 distinguishes from delivery, an open or a read.
 */

const TIER_LABEL: Record<string, string> = {
  full: 'Full engagement',
  monitoring: 'Monitoring',
};

const STATUS_TONE: Record<string, StatusTone> = {
  created: 'info',
  clicked: 'warning',
  completed: 'success',
  abandoned: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  created: 'Issued',
  clicked: 'Clicked',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

/** Only http(s) and same-origin paths become links (§10.5). */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export default function UpgradesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [upgrades, setUpgrades] = useState<Upgrade[] | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [ledger, leadRows] = await Promise.all([
          listUpgrades(projectId, { signal }),
          listLeadRows(projectId, undefined, { signal }),
        ]);
        setUpgrades(ledger);
        setLeads(leadRows);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const leadById = useMemo(() => {
    const map = new Map<string, Lead>();
    for (const lead of leads ?? []) map.set(lead.id, lead);
    return map;
  }, [leads]);

  async function onRecordClick(upgrade: Upgrade) {
    setBusyId(upgrade.id);
    setActionError(null);
    try {
      await markUpgradeClicked(projectId, upgrade.id);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusyId(null);
    }
  }

  const columns = useMemo<ReadonlyArray<ColumnDef<Upgrade>>>(
    () => [
      {
        key: 'tier',
        header: 'Offer',
        accessor: (row) => row.tier,
        sortable: true,
        width: 180,
        render: (row) => (
          <div>
            <div className="font-medium">{TIER_LABEL[row.tier] ?? row.tier}</div>
            <div className="font-mono text-meta text-muted-foreground">{row.tier}</div>
          </div>
        ),
      },
      {
        key: 'lead',
        header: 'Lead',
        accessor: (row) => (row.leadId ? leadById.get(row.leadId)?.email ?? row.leadId : ''),
        render: (row) => {
          if (!row.leadId) {
            return <span className="text-muted-foreground">Not linked to a lead</span>;
          }
          const lead = leadById.get(row.leadId);
          if (!lead) {
            return <span className="font-mono text-meta">{row.leadId}</span>;
          }
          return (
            <Link
              className="text-primary underline-offset-4 hover:underline"
              href={`/ops/projects/${projectId}/sales/${lead.id}`}
            >
              {lead.name ?? lead.email}
            </Link>
          );
        },
      },
      {
        key: 'timeline',
        header: 'Issued → clicked → completed',
        accessor: (row) => row.createdAt,
        sortable: true,
        render: (row) => (
          <ol className="space-y-1">
            <Step
              done
              label="Issued"
              at={row.createdAt}
              detail="A checkout link was created and recorded."
            />
            <Step
              done={row.status === 'clicked' || row.status === 'completed'}
              label="Clicked"
              at={null}
              detail={
                row.status === 'clicked' || row.status === 'completed'
                  ? row.leadId
                    ? 'Recorded in the lead’s CTA history — a click is not a purchase.'
                    : 'Recorded on this ledger row.'
                  : 'Not opened yet.'
              }
            />
            <Step
              done={row.status === 'completed'}
              label="Completed"
              at={row.completedAt}
              detail={
                row.status === 'completed'
                  ? 'Recorded by the unsigned payment stand-in, not by a verified payment event.'
                  : row.status === 'abandoned'
                    ? 'Abandoned.'
                    : 'No completion recorded.'
              }
              uncertain={row.status === 'completed'}
            />
          </ol>
        ),
      },
      {
        key: 'status',
        header: 'Ledger status',
        accessor: (row) => row.status,
        sortable: true,
        width: 140,
        render: (row) => (
          <StatusPill
            label={STATUS_LABEL[row.status] ?? row.status}
            tone={STATUS_TONE[row.status] ?? 'neutral'}
          />
        ),
      },
      {
        key: 'checkoutUrl',
        header: 'Checkout link',
        accessor: (row) => row.checkoutUrl ?? '',
        render: (row) => {
          const href = safeHref(row.checkoutUrl);
          if (!row.checkoutUrl) {
            return (
              <span className="text-muted-foreground">
                No link recorded on this row
              </span>
            );
          }
          if (!href) {
            // A non-http(s) value is shown as text rather than made clickable.
            return (
              <span className="text-meta text-muted-foreground">
                {row.checkoutUrl} (not a link: unsupported URL scheme)
              </span>
            );
          }
          return (
            <a
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              href={href}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open the checkout page
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            </a>
          );
        },
      },
      {
        key: 'stripeSessionId',
        header: 'Session id',
        accessor: (row) => row.stripeSessionId ?? '',
        defaultHidden: true,
        emptyLabel: 'No session id recorded',
        render: (row) =>
          row.stripeSessionId ? (
            <span className="font-mono text-meta">{row.stripeSessionId}</span>
          ) : null,
      },
      {
        key: 'actions',
        header: '',
        alwaysVisible: true,
        width: 210,
        align: 'right',
        render: (row) =>
          row.status === 'created' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busyId === row.id}
              onClick={() => void onRecordClick(row)}
            >
              <MousePointerClick aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
              {busyId === row.id ? 'Recording…' : 'Record a click'}
            </Button>
          ) : (
            <span className="text-meta text-muted-foreground">
              {row.status === 'completed'
                ? 'Completed — nothing to record here'
                : 'Already clicked'}
            </span>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId, leadById, projectId],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Sales pipeline', href: '/ops/sales' }]}
          title="Offers and upgrades"
        />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!upgrades || !leads) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Sales pipeline', href: '/ops/sales' }]}
        title="Offers and upgrades"
        context={`${upgrades.length} checkout link${upgrades.length === 1 ? '' : 's'} on this project.`}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {/*
        The single most important sentence on this screen. It is an alert, not
        a footnote, because the difference between "the ledger says completed"
        and "the customer paid" is the difference between a correct business
        decision and a wrong one.
      */}
      <Alert variant="destructive" role="alert">
        <ShieldAlert aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>Completion on this ledger is not a verified payment</AlertTitle>
        <AlertDescription>
          <p>
            Issued, clicked and completed are three different facts, and only the
            first two come from something this system observed directly. The
            completion route is an <strong>unsigned stand-in</strong> for the
            payment provider&rsquo;s webhook: it takes no signature, so nothing
            on this page establishes that money moved.
          </p>
          <p className="mt-1">
            There is deliberately no button here to mark an upgrade completed —
            that would make a browser action the thing that grants a paid
            entitlement. Treat this ledger as a record of what was offered and
            what was seen, and confirm payment in the payment provider until the
            verified-webhook work (G16) lands.
          </p>
        </AlertDescription>
      </Alert>

      {actionError ? <ErrorState error={actionError} layout="inline" /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <IssueLinkCard
          projectId={projectId}
          leads={leads}
          onIssued={() => void load()}
        />
        <HandoffEmailCard projectId={projectId} leads={leads} />
      </div>

      <section className="space-y-3" aria-labelledby="upgrade-ledger">
        <h2 id="upgrade-ledger" className="text-subsection font-semibold">
          Checkout ledger
        </h2>
        <p className="text-table text-muted-foreground">
          Newest first. A click is recorded here and, when the link is attached
          to a lead, appended to that lead&rsquo;s CTA history too — which is
          where the click&rsquo;s timestamp lives.
        </p>
        <DataTable
          caption="Upgrade ledger"
          columns={columns}
          rows={upgrades}
          getRowId={(row) => row.id}
          minTableWidth="72rem"
          defaultSort={{ key: 'timeline', direction: 'desc' }}
          filters={[
            {
              id: 'tier',
              label: 'Offer',
              options: UPGRADE_TIERS.map((tier) => ({
                value: tier,
                label: TIER_LABEL[tier] ?? tier,
              })),
              getValue: (row) => row.tier,
            },
            {
              id: 'status',
              label: 'Status',
              options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
              getValue: (row) => row.status,
            },
          ]}
          emptyState={
            <EmptyState
              variant="not-measured"
              subject="checkout links for this project"
              prerequisite="Issuing one above. Without a configured checkout URL for the tier, the route refuses (503) and records nothing."
            />
          }
        />
      </section>
    </div>
  );
}

function Step({
  done,
  label,
  at,
  detail,
  uncertain,
}: {
  done: boolean;
  label: string;
  at: string | null;
  detail: string;
  uncertain?: boolean;
}) {
  return (
    <li className="flex gap-2">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          done ? (uncertain ? 'bg-warning' : 'bg-success') : 'bg-border-strong'
        }`}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-table ${done ? 'font-medium' : 'text-muted-foreground'}`}>
            {label}
          </span>
          {/* The state is stated in text; the dot is decorative only (§3.4). */}
          <span className="text-meta text-muted-foreground">
            {done ? (uncertain ? 'recorded, unverified' : 'yes') : 'no'}
          </span>
          {at ? (
            <span className="text-meta text-muted-foreground">
              <Timestamp value={at} />
            </span>
          ) : null}
        </div>
        <p className="text-meta text-muted-foreground">{detail}</p>
      </div>
    </li>
  );
}

function IssueLinkCard({
  projectId,
  leads,
  onIssued,
}: {
  projectId: string;
  leads: Lead[];
  onIssued: () => void;
}) {
  const [tier, setTier] = useState<UpgradeTier>('full');
  const [leadId, setLeadId] = useState<string>('none');
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [issued, setIssued] = useState<Upgrade | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const upgrade = await issueUpgrade(projectId, {
        tier,
        ...(leadId === 'none' ? {} : { leadId }),
      });
      setIssued(upgrade);
      onIssued();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-table font-medium">Issue a checkout link</CardTitle>
        <p className="text-meta text-muted-foreground">
          Records the issue immediately. The link points at the deployment&rsquo;s
          configured checkout page for the tier.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <ErrorState
              error={error}
              layout="inline"
              fieldIdPrefix="upgrade-"
              preserveNotice="Nothing was recorded."
              providerName="the payment provider"
            />
          ) : null}

          {issued ? (
            <Alert>
              <TicketCheck aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>Link issued</AlertTitle>
              <AlertDescription>
                {TIER_LABEL[issued.tier] ?? issued.tier} for{' '}
                {issued.leadId ? leadByIdLabel(leads, issued.leadId) : 'no particular lead'}.
                It is on the ledger below as <strong>issued</strong> — a link
                having been created is not a click and not a payment.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="upgrade-tier">Offer</Label>
              <Select value={tier} onValueChange={(value) => setTier(value as UpgradeTier)}>
                <SelectTrigger id="upgrade-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UPGRADE_TIERS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {TIER_LABEL[option] ?? option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="upgrade-lead">Attach to a lead</Label>
              <Select value={leadId} onValueChange={setLeadId}>
                <SelectTrigger id="upgrade-lead">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No particular lead</SelectItem>
                  {leads.map((lead) => (
                    <SelectItem key={lead.id} value={lead.id}>
                      {lead.name ?? lead.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                Attaching a lead is what makes a click appear in that
                lead&rsquo;s CTA history as well as here.
              </p>
            </div>
          </div>

          <Button type="submit" disabled={busy}>
            {busy ? 'Issuing…' : `Issue a ${TIER_LABEL[tier] ?? tier} checkout link`}
          </Button>

          <p className="text-meta text-muted-foreground">
            If the deployment has no checkout URL configured for this tier, the
            request is refused with <code className="font-mono">payment-unconfigured</code>{' '}
            and nothing is recorded — a funnel step that cannot proceed is not
            persisted.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

function HandoffEmailCard({ projectId, leads }: { projectId: string; leads: Lead[] }) {
  const [to, setTo] = useState('');
  const [reportUrl, setReportUrl] = useState('');
  const [subject, setSubject] = useState('');
  const [reviewAsk, setReviewAsk] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof sendHandoffEmail>> | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await sendHandoffEmail(projectId, {
          to,
          reportUrl,
          subject: subject.trim() === '' ? undefined : subject,
          includeTestimonialAsk: reviewAsk,
        }),
      );
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-table font-medium">Send the handoff</CardTitle>
        <p className="text-meta text-muted-foreground">
          One email: the report link, the booking CTA, and optionally the
          review ask. Sending is always an explicit action.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <ErrorState
              error={error}
              layout="inline"
              fieldIdPrefix="handoff-"
              preserveNotice="Nothing was sent and your text is still here."
              providerName="the email provider"
            />
          ) : null}

          {result ? (
            <Alert variant={result.delivered ? 'default' : 'destructive'} role="alert">
              <Mail aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>
                {result.delivered
                  ? 'The provider accepted the message'
                  : 'The send failed'}
              </AlertTitle>
              <AlertDescription>
                <p>
                  To <strong>{result.to}</strong>, linking{' '}
                  <span className="font-mono text-meta break-all">{result.reportUrl}</span>.
                  {result.messageId ? (
                    <>
                      {' '}
                      Message id <span className="font-mono text-meta">{result.messageId}</span>.
                    </>
                  ) : null}
                </p>
                {result.error ? <p className="mt-1">{result.error}</p> : null}
                {result.delivered ? (
                  <p className="mt-1">
                    <strong>Accepted is not delivered.</strong> This response says
                    the provider took the message; it does not establish delivery,
                    an open or a read. Do not treat it as confirmation the
                    recipient has seen anything.
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="handoff-reportUrl">
              Report URL <span className="text-muted-foreground">(required)</span>
            </Label>
            <Input
              id="handoff-reportUrl"
              required
              minLength={8}
              placeholder="https://…/r/abc123"
              value={reportUrl}
              onChange={(event) => setReportUrl(event.target.value)}
            />
            <p className="text-meta text-muted-foreground">
              A link, not an attachment. For an unauthenticated recipient the
              report must be publicly visible first; a portal URL requires the
              recipient to sign in and an operator preview URL will not work for
              them at all.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="handoff-to">
                Recipient <span className="text-muted-foreground">(required)</span>
              </Label>
              <Input
                id="handoff-to"
                type="email"
                required
                list="handoff-lead-emails"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
              <datalist id="handoff-lead-emails">
                {leads.map((lead) => (
                  <option key={lead.id} value={lead.email} />
                ))}
              </datalist>
              <p className="text-meta text-muted-foreground">
                Any address, not only a lead on this project.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="handoff-subject">Subject</Label>
              <Input
                id="handoff-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Use the default subject"
              />
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Switch id="handoff-reviewAsk" checked={reviewAsk} onCheckedChange={setReviewAsk} />
            <div>
              <Label htmlFor="handoff-reviewAsk" className="text-table">
                Include the review/testimonial ask
              </Label>
              <p className="text-meta text-muted-foreground">
                Adds a second call to action beside the booking link. Use it only
                where a relationship already exists — it is not a default.
              </p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || to.trim() === '' || reportUrl.trim() === ''}>
              <Mail aria-hidden="true" className="mr-2 h-4 w-4" />
              {busy ? 'Sending…' : 'Send this email'}
            </Button>
            <p className="text-meta text-muted-foreground">
              The sender identity is the deployment&rsquo;s, not something chosen
              here.
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function leadByIdLabel(leads: Lead[], id: string): string {
  const lead = leads.find((entry) => entry.id === id);
  return lead ? lead.name ?? lead.email : id;
}
