'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, LogOut, ShieldOff, UserRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useSession } from '@/hooks/useSession';
import { formatCurrency } from '@/lib/format';
import { getPortalMe, type PortalMe } from '@/services/portal';
import {
  getPortalCustomerPortalState,
  listPortalEntitlements,
  listPortalInvoices,
  listPortalSubscriptions,
  type PortalCustomerPortalState,
  type PortalEntitlement,
  type PortalInvoices,
  type PortalSubscription,
} from '@/services/portal-billing';

/**
 * CP15 — Account and service.
 *
 * design_plan.md §4.5: *"Profile/security, service scope/lead, preferences,
 * invoices if offered."* Its support column reads "P logout E; profile/security
 * G01, billing G16" — which is exactly the split this page renders:
 *
 *  1. **Profile** comes from `GET /api/portal/me` (G01). That service method
 *     exists and returns the shape below, but **no controller exposes it in
 *     this build** — `AuthController.me` is operator-only *by design*, and
 *     RolesGuard refuses a client at every route that is not `@ClientPortal()`.
 *     Rather than show an empty profile card, this page states that the
 *     endpoint is missing, names it, and shows what does work.
 *  2. **Security** is sign-out only, and the page says why. §5.2 is explicit:
 *     *"Do not display a working 'Change temporary password' CTA until G01
 *     exists. The current emailed instruction to change it is not supported by
 *     an actual self-service endpoint."* Password change and session management
 *     live on `/auth/*`, which is operator-only, so they are rendered as
 *     explicitly unavailable with that reason — not as disabled buttons that
 *     look like a permissions problem.
 *  3. **Service scope** comes from G16's read-only billing surface: what the
 *     account is subscribed to, what it is entitled to (including expired and
 *     revoked rows — a revoked entitlement is a fact the client may see), and
 *     the payment history. Nothing here can buy, cancel or revoke: the portal is
 *     deliberately not a second way to grant access.
 *
 * There is no client-visible delivery-lead field in the API, so this page does
 * not print a name next to "your lead" — it points at the messages thread,
 * where the delivery team is. Preferences have no backing endpoint either and
 * are listed as unavailable rather than faked with local-only switches.
 */
export default function ClientAccountPage() {
  const { signOut, user } = useSession();

  const [me, setMe] = useState<PortalMe | null>(null);
  const [meUnavailable, setMeUnavailable] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<PortalSubscription[] | null>(null);
  const [entitlements, setEntitlements] = useState<PortalEntitlement[] | null>(null);
  const [invoices, setInvoices] = useState<PortalInvoices | null>(null);
  const [customerPortal, setCustomerPortal] = useState<PortalCustomerPortalState | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const [meResult, subscriptionsResult, entitlementsResult, invoicesResult, portalResult] =
        await Promise.allSettled([
          getPortalMe({ signal }),
          listPortalSubscriptions({ signal }),
          listPortalEntitlements({ signal }),
          listPortalInvoices({ signal }),
          getPortalCustomerPortalState({ signal }),
        ]);

      if (meResult.status === 'fulfilled') {
        setMe(meResult.value);
        setMeUnavailable(null);
      } else {
        setMe(null);
        setMeUnavailable(describeMeFailure(meResult.reason));
      }

      if (subscriptionsResult.status === 'fulfilled') setSubscriptions(subscriptionsResult.value);
      if (entitlementsResult.status === 'fulfilled') setEntitlements(entitlementsResult.value);
      if (invoicesResult.status === 'fulfilled') setInvoices(invoicesResult.value);
      if (portalResult.status === 'fulfilled') setCustomerPortal(portalResult.value);

      // Only a total failure is a page-level error: one missing section must
      // not blank the whole account screen.
      if (
        subscriptionsResult.status === 'rejected' &&
        entitlementsResult.status === 'rejected' &&
        invoicesResult.status === 'rejected'
      ) {
        throw subscriptionsResult.reason;
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Account and service" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  const loading = subscriptions === null && entitlements === null && invoices === null;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account and service"
        context={me ? `${me.client.name} · signed in as ${me.email}` : 'Your profile, access and what you are subscribed to.'}
      />

      {/* ── Profile ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {me ? (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
              <Fact label="Name">{me.name}</Fact>
              <Fact label="Email">
                <span className="font-mono text-meta">{me.email}</span>
              </Fact>
              <Fact label="Account">
                {me.client.name}
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  Status: {me.client.status}
                </span>
              </Fact>
              <Fact label="Account created">
                <Timestamp value={me.createdAt} dateOnly />
              </Fact>
            </dl>
          ) : (
            <>
              <EmptyState
                variant="not-measured"
                subject="your profile details"
                prerequisite="The endpoint this reads — GET /api/portal/me — is not part of the deployed API yet, so there is nothing to show rather than something missing from your account."
              />
              <Alert>
                <UserRound aria-hidden="true" className="h-4 w-4" />
                <AlertTitle>What this means, and what to do</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{meUnavailable}</p>
                  <p>
                    Your account and everything in it is working — this is a
                    screen-level gap, not an account problem. To change your
                    name, email or password, ask your delivery team in{' '}
                    <Link href="/client/messages" className="text-primary underline underline-offset-4">
                      messages
                    </Link>
                    .
                  </p>
                  {user?.email ? (
                    <p className="text-meta">
                      You are signed in as the account this session belongs to; the
                      header above shows it.
                    </p>
                  ) : null}
                </AlertDescription>
              </Alert>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Security ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" className="mr-2 h-4 w-4" />
              Sign out
            </Button>
            <span className="text-meta text-muted-foreground">
              Signs this browser out of the portal.
            </span>
          </div>

          <ul className="divide-y divide-border border-t border-border pt-2">
            <UnavailableRow
              icon={KeyRound}
              label="Change your password"
              reason="Password change lives on an operator-only route in this build, so there is no self-service endpoint a client can call yet. Ask your delivery team to reset it for you — deliberately, no 'change password' button is shown, because a control that cannot work is worse than none."
            />
            <UnavailableRow
              icon={ShieldOff}
              label="See or revoke other sessions"
              reason="Session management is also operator-only in this build. If you think someone else has your password, message your delivery team: they can reset it, which revokes every session."
            />
          </ul>
        </CardContent>
      </Card>

      {/* ── Service scope ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Your service</CardTitle>
          {subscriptions && subscriptions.length > 0 ? (
            <StatusPill
              label={subscriptionLabel(subscriptions[0].status)}
              tone={subscriptionTone(subscriptions[0].status)}
            />
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {subscriptions === null ? (
            <p className="text-table text-muted-foreground">
              The subscription could not be read just now. Reload to try again.
            </p>
          ) : subscriptions.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="a subscription"
              prerequisite="Nothing is recorded against your account yet. Your delivery lead sets this up when an engagement starts."
            />
          ) : (
            <ul className="divide-y divide-border">
              {subscriptions.map((subscription) => (
                <li key={subscription.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-table font-medium">
                      {subscriptionLabel(subscription.status)}
                    </span>
                    {subscription.currentPeriodEnd ? (
                      <span className="text-meta text-muted-foreground">
                        Current period ends <Timestamp value={subscription.currentPeriodEnd} dateOnly />
                      </span>
                    ) : null}
                  </div>
                  {subscription.canceledAt ? (
                    <p className="text-meta text-warning-foreground">
                      Cancelled on <Timestamp value={subscription.canceledAt} dateOnly />
                      {subscription.cancelAt ? (
                        <>
                          {' '}
                          — access runs to <Timestamp value={subscription.cancelAt} dateOnly />.
                        </>
                      ) : null}
                    </p>
                  ) : subscription.cancelAt ? (
                    <p className="text-meta text-warning-foreground">
                      Set to cancel on <Timestamp value={subscription.cancelAt} dateOnly />.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div>
            <h3 className="text-table font-semibold">What you are entitled to use</h3>
            {entitlements === null ? (
              <p className="text-table text-muted-foreground">
                Entitlements could not be read just now.
              </p>
            ) : entitlements.length === 0 ? (
              <p className="text-table text-muted-foreground">
                No entitlement is recorded, so nothing beyond the agreed service
                is unlocked. Revoked and expired entitlements appear here too,
                rather than disappearing.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {entitlements.map((entitlement) => (
                  <li key={entitlement.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-table">{humanizeKey(entitlement.key)}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        label={entitlementLabel(entitlement)}
                        tone={entitlementTone(entitlement)}
                      />
                      <span className="text-meta text-muted-foreground">
                        from <Timestamp value={entitlement.startsAt} dateOnly />
                        {entitlement.expiresAt ? (
                          <>
                            {' '}
                            to <Timestamp value={entitlement.expiresAt} dateOnly />
                          </>
                        ) : null}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {customerPortal ? (
            <Alert>
              <AlertTitle>Changing or cancelling your plan</AlertTitle>
              <AlertDescription>
                {customerPortal.reason}{' '}
                <Link href="/client/messages" className="text-primary underline underline-offset-4">
                  Send a message
                </Link>{' '}
                and it is recorded against your account either way.
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="text-meta text-muted-foreground">
            Who your delivery lead is is not shown on this screen — there is no
            client-visible lead field in this build. The{' '}
            <Link href="/client/messages" className="text-primary underline underline-offset-4">
              messages
            </Link>{' '}
            thread is where your delivery team reads and answers.
          </p>
        </CardContent>
      </Card>

      {/* ── Invoices ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Payment history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {invoices === null ? (
            <p className="text-table text-muted-foreground">
              Payment history could not be read just now. Reload to try again.
            </p>
          ) : invoices.invoices.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="payment lines"
              prerequisite="No verified payment has been recorded against your account yet."
            />
          ) : (
            <ul className="divide-y divide-border">
              {invoices.invoices.map((line) => (
                <li
                  key={line.eventId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="text-table">
                    {humanizeKey(line.eventType.replace(/^[a-z]+\./, ''))}
                    <span className="ml-2 text-meta text-muted-foreground">
                      <Timestamp value={line.occurredAt} dateOnly />
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-table tabular-nums">
                      {/*
                        No currency code means no currency symbol: a default of
                        USD would silently relabel another client's currency.
                      */}
                      {line.amountCents === null
                        ? 'Amount not recorded'
                        : line.currency
                          ? formatCurrency(line.amountCents / 100, line.currency)
                          : `${(line.amountCents / 100).toFixed(2)} (currency not supplied)`}
                    </span>
                    <StatusPill
                      label={line.verified ? 'Verified' : 'Unverified'}
                      tone={line.verified ? 'success' : 'unmeasured'}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {invoices ? (
            <p className="text-meta text-muted-foreground">
              {invoices.providerInvoices.reason}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Preferences ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Preferences</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            <UnavailableRow
              icon={UserRound}
              label="Notification preferences"
              reason="This build has no notification settings API, so there is nothing to configure here. Everything that needs your attention appears on your Home, Approvals and Messages screens."
            />
          </ul>
          <p className="text-meta text-muted-foreground">
            Settings shown as unavailable are not hidden by permissions — the
            feature does not exist yet, and this page will not offer a switch that
            changes nothing.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-table">{children}</dd>
    </div>
  );
}

function UnavailableRow({
  icon: Icon,
  label,
  reason,
}: {
  icon: typeof KeyRound;
  label: string;
  reason: string;
}) {
  return (
    <li className="flex items-start gap-2 py-3">
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-table font-medium">{label}</span>
          <span className="rounded-full bg-unmeasured-subtle px-2 py-0.5 text-meta text-unmeasured-foreground">
            Not available yet
          </span>
        </span>
        <span className="mt-0.5 block text-meta text-muted-foreground">{reason}</span>
      </span>
    </li>
  );
}

function subscriptionLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'trialing':
      return 'Trial';
    case 'past_due':
      return 'Payment past due';
    case 'canceled':
    case 'cancelled':
      return 'Cancelled';
    case 'paused':
      return 'Paused';
    default:
      return status;
  }
}

function subscriptionTone(status: string): StatusTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'trialing':
      return 'info';
    case 'past_due':
      return 'warning';
    case 'canceled':
    case 'cancelled':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}

function entitlementLabel(entitlement: PortalEntitlement): string {
  if (entitlement.revokedAt) return 'Revoked';
  if (entitlement.expiresAt && new Date(entitlement.expiresAt).getTime() < Date.now()) {
    return 'Expired';
  }
  return entitlement.status.charAt(0).toUpperCase() + entitlement.status.slice(1);
}

function entitlementTone(entitlement: PortalEntitlement): StatusTone {
  if (entitlement.revokedAt) return 'unmeasured';
  if (entitlement.expiresAt && new Date(entitlement.expiresAt).getTime() < Date.now()) {
    return 'unmeasured';
  }
  return entitlement.status === 'active' ? 'success' : 'neutral';
}

function humanizeKey(key: string): string {
  return key
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Why the profile read failed.
 *
 * The two cases are different facts and are worth distinguishing: a 404 means
 * the route is not deployed (a build gap), while anything else is a live
 * failure worth retrying.
 */
function describeMeFailure(cause: unknown): string {
  const kind =
    cause && typeof cause === 'object' && 'kind' in cause
      ? (cause as { kind?: string }).kind
      : undefined;
  if (kind === 'not-found') {
    return 'The account endpoint this card reads returns 404: it is not registered on the server running this build. Your identity still exists — it is simply not readable from here.';
  }
  if (kind === 'forbidden') {
    return 'The server refused this read. Client accounts are only allowed on routes marked for the client portal, and this endpoint is not one of them in this build.';
  }
  if (kind === 'unauthenticated') {
    return 'Your session has expired. Sign in again to see your profile.';
  }
  if (kind === 'network') {
    return 'The server could not be reached, so your profile could not be read. Nothing has changed on your account.';
  }
  return 'Your profile details could not be read just now. Reload to try again.';
}
