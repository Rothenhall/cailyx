'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Clock, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PublicShell } from '@/components/layouts/PublicShell';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatCurrency } from '@/lib/format';
import { getCheckoutStatus, type CheckoutStatus } from '@/services/billing';

/**
 * PB04 — Checkout return.
 *
 * design_plan.md §4.1: *"Pending/verified payment, purchased offer, next
 * action"*. §5.11 and acceptance journey 16 fix the rule this page exists to
 * keep: **a checkout-return visit, a browser callback or a button click grants
 * nothing.** The entitlement comes from a signature-verified payment event
 * processed by the backend, and the only thing this page can do is *ask* what
 * the ledger says.
 *
 * So the page never infers anything from the URL's presence or from the
 * redirect. It reads `GET /public/checkout/status` — a read that cannot write,
 * cannot grant and cannot be satisfied by a caller-supplied paid status — and
 * renders exactly what came back:
 *
 *  - `pending` is reported as *no signed confirmation has arrived yet*, which
 *    is neither a failure nor a purchase. The wording matters: telling someone
 *    "your payment failed" when the webhook is merely in flight is a false
 *    statement about their money.
 *  - `verified` lists the offer and the entitlements the event authorized.
 *  - `rejected` and `ignored` are reported as what they are, with the server's
 *    own reason.
 *
 * Re-checking is safe at any time — it is a read — so the pending state offers
 * it rather than leaving the visitor to reload blindly.
 */
export default function CheckoutResultPage() {
  return (
    <PublicShell contextLabel="Checkout">
      {/* `useSearchParams` opts the route out of static prerender without a
          boundary; this keeps the rest of the page static. */}
      <Suspense fallback={<CheckoutSkeleton />}>
        <CheckoutResult />
      </Suspense>
    </PublicShell>
  );
}

function CheckoutResult() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId') ?? '';

  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!sessionId) return;
      setLoading(true);
      try {
        setError(null);
        setStatus(await getCheckoutStatus(sessionId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!sessionId) {
    return (
      <div className="space-y-6">
        <h1 className="text-title font-semibold tracking-tight">Checkout</h1>
        <Alert>
          <ShieldAlert aria-hidden="true" className="h-4 w-4 text-warning" />
          <AlertTitle>This page needs the checkout session reference</AlertTitle>
          <AlertDescription>
            It reads the payment provider&apos;s confirmation for one checkout
            session, and without a session reference there is nothing to read —
            nothing is assumed from arriving here. Open the link the provider
            returned you to, or use the original checkout link from your
            confirmation email.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-title font-semibold tracking-tight">Checkout</h1>
        <ErrorState
          error={error}
          onRetry={() => void load()}
          notFoundReason="missing"
          providerName="the payment provider"
        />
      </div>
    );
  }

  if (!status) return <CheckoutSkeleton />;

  const verified = status.status === 'verified' && status.purchaseVerified;

  return (
    <div className="space-y-6">
      {/* The snapshot label here means "this is the ledger's answer at the
          moment it was read", not a frozen report — re-checking can change it
          as a signed event lands. */}
      <ScopeBanner
        scope={{ mode: 'snapshot', snapshotLabel: `Checked ${new Date().toLocaleTimeString()}` }}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? 'Checking…' : 'Check again'}
          </Button>
        }
      />

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          {verified ? (
            <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-success" />
          ) : (
            <Clock aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
          )}
          <StatusPill
            label={
              status.status === 'verified'
                ? 'Payment verified'
                : status.status === 'pending'
                  ? 'Awaiting confirmation'
                  : status.status === 'rejected'
                    ? 'Confirmation rejected'
                    : 'Not applied'
            }
            tone={verified ? 'success' : status.status === 'pending' ? 'warning' : 'danger'}
          />
        </div>
        <h1 className="text-title font-semibold tracking-tight">
          {verified ? 'Your payment is confirmed' : 'No confirmed payment yet'}
        </h1>
        <p className="text-table text-muted-foreground">{status.nextAction}</p>
      </header>

      {/*
        The rule this page exists to state, in the visitor's own terms. It is
        not a disclaimer paragraph at the bottom of a receipt — it is the
        difference between "you have access" and "we are waiting for the
        provider to tell us that you do".
      */}
      <Alert>
        <ShieldAlert aria-hidden="true" className="h-4 w-4 text-warning" />
        <AlertTitle>Opening this page grants nothing</AlertTitle>
        <AlertDescription>
          Access is granted only when the payment provider&apos;s signed
          confirmation reaches Cailyx and is verified. Returning from checkout,
          reloading this page, or the provider sending you here proves nothing on
          its own — which is why this page reports the ledger rather than
          assuming a result from your arrival.
        </AlertDescription>
      </Alert>

      {status.status === 'pending' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">What is happening</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-table">
            <p>
              {status.onRecord
                ? 'A payment event for this checkout has reached us and is still being processed.'
                : 'No payment event for this checkout has reached us yet.'}
            </p>
            <p className="text-muted-foreground">
              This is normal for the first moments after a payment and it is not a
              failure. Give it a minute and use “Check again”. If you were charged
              and nothing changes, contact your delivery lead with the session
              reference below — you do not need to pay again.
            </p>
            {status.reason ? (
              <p className="text-meta text-muted-foreground">{status.reason}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {status.status === 'rejected' || status.status === 'ignored' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Why nothing was granted</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-table">
            <p>
              {status.status === 'rejected'
                ? 'A payment event for this checkout arrived but did not pass signature verification, so it was not acted on.'
                : 'A payment event for this checkout was verified but deliberately not acted on.'}
            </p>
            {status.reason ? <p className="text-muted-foreground">{status.reason}</p> : null}
            <p className="text-muted-foreground">
              Nothing has been granted from this event. Contact your delivery lead
              before paying again.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">
            {verified ? 'What was purchased' : 'What this checkout was for'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {status.offer ? (
            <dl className="space-y-1.5 text-table">
              <div className="flex flex-wrap gap-x-3">
                <dt className="text-muted-foreground">Offer</dt>
                <dd className="font-medium">{status.offer.name}</dd>
              </div>
              <div className="flex flex-wrap gap-x-3">
                <dt className="text-muted-foreground">Reference</dt>
                <dd className="font-mono text-meta">{status.offer.code}</dd>
              </div>
              <div className="flex flex-wrap gap-x-3">
                <dt className="text-muted-foreground">Amount</dt>
                <dd>
                  {/* Amount and currency are kept as a pair; no unit is assumed
                      when the provider supplied none. */}
                  {formatCurrency(status.offer.amountCents / 100, status.offer.currency.toUpperCase())}
                  {status.offer.interval && status.offer.interval !== 'one-time'
                    ? ` per ${status.offer.interval === 'monthly' ? 'month' : status.offer.interval}`
                    : ''}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-table text-muted-foreground">
              No offer is resolved for this checkout yet. The offer is read from
              the verified event, not from the link you arrived on, so it appears
              only once that event has been processed.
            </p>
          )}

          <div>
            <div className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
              Entitlements
            </div>
            {status.entitlements.length === 0 ? (
              <p className="mt-1 text-table text-muted-foreground">
                Nothing is granted for this checkout. That is the expected state
                until a signed payment event is verified.
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {status.entitlements.map((entitlement) => (
                  <li key={entitlement.key} className="flex items-center gap-2 text-table">
                    <StatusPill
                      label={entitlement.status}
                      tone={entitlement.status === 'active' ? 'success' : 'neutral'}
                    />
                    <span className="font-mono text-meta">{entitlement.key}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Checkout reference</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-1.5 text-table">
            <div className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">Session</dt>
              <dd className="break-all font-mono text-meta">{status.sessionId}</dd>
            </div>
            {status.eventType ? (
              <div className="flex flex-wrap gap-x-3">
                <dt className="text-muted-foreground">Event</dt>
                <dd className="font-mono text-meta">{status.eventType}</dd>
              </div>
            ) : null}
            {status.receivedAt ? (
              <div className="flex flex-wrap gap-x-3">
                <dt className="text-muted-foreground">Received</dt>
                <dd>
                  <Timestamp value={status.receivedAt} />
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-3 text-meta text-muted-foreground">
            Quote this reference when asking about the payment — it identifies the
            checkout without anyone needing a card number or an email address.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href="/sign-in">Sign in</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/request-audit">Request a diagnostic</Link>
        </Button>
      </div>
    </div>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
