'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PublicShell } from '@/components/layouts/PublicShell';
import { Timestamp } from '@/components/patterns/Timestamp';
import { ApiError } from '@/lib/api';
import {
  CONSENT_STATEMENT,
  getDiagnosticChallenge,
  solveChallenge,
  submitDiagnosticRequest,
  type DiagnosticChallenge,
  type DiagnosticReceipt,
} from '@/services/billing';

/**
 * PB03 — Request a diagnostic.
 *
 * design_plan.md §4.1: *"Domain, contact, intended goal, submission receipt"*,
 * in the Access-forms layout family (§4): identity/context first, fields
 * second, one submit, inline validation plus a summary, non-secret inputs
 * preserved after a failure, full width on mobile.
 *
 * This is a public form, so it is written to assume the caller is hostile:
 *
 *  - The server issues a signed, expiring, single-use challenge with a **proof
 *    of work** attached, and refuses a submission without a solved one. The
 *    browser solves it here. The progress line reports hashes actually
 *    computed — it is work, not an animation, and there is no invented
 *    percentage next to it.
 *  - The submission is refused unless `consent` is true. That is not a
 *    formality: the record's whole point is that the person agreed to be
 *    contacted, so the consent sentence is shown verbatim and unchecked by
 *    default.
 *  - A domain can only generate a handful of requests per day. Hitting that cap
 *    is reported as what it is, with the address to use instead.
 *
 * What the request actually does is stated on the page rather than implied: it
 * creates a project stub and a queued receipt for a human. It does not fetch
 * the site, does not run any audit, and does not expense anything.
 */
export default function RequestAuditPage() {
  const [challenge, setChallenge] = useState<DiagnosticChallenge | null>(null);
  const [challengeError, setChallengeError] = useState<ApiError | null>(null);
  const [challengeLoading, setChallengeLoading] = useState(true);

  const [domain, setDomain] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactName, setContactName] = useState('');
  const [company, setCompany] = useState('');
  const [goal, setGoal] = useState('');
  const [consent, setConsent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [hashesTried, setHashesTried] = useState(0);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [receipt, setReceipt] = useState<DiagnosticReceipt | null>(null);
  const [expired, setExpired] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const loadChallenge = useCallback(async (signal?: AbortSignal) => {
    setChallengeLoading(true);
    try {
      setChallengeError(null);
      setExpired(false);
      setHashesTried(0);
      setChallenge(await getDiagnosticChallenge({ signal }));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setChallengeError(toApiError(caught));
    } finally {
      setChallengeLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadChallenge(controller.signal);
    return () => controller.abort();
  }, [loadChallenge]);

  // The challenge is time-boxed by its own signed expiry, so the screen tracks
  // it rather than letting a submit fail with "expired" after the submitter has
  // filled in the whole form.
  useEffect(() => {
    if (!challenge) return;
    const remaining = new Date(challenge.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [challenge]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const canSubmit =
    !submitting &&
    !expired &&
    Boolean(challenge) &&
    domain.trim().length >= 3 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim()) &&
    consent;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || !canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);
    setHashesTried(0);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const answer = await solveChallenge(challenge.token, challenge.difficultyBits, {
        signal: controller.signal,
        onProgress: setHashesTried,
      });

      const answerReceipt = await submitDiagnosticRequest({
        domain: domain.trim(),
        contactEmail: contactEmail.trim(),
        contactName: contactName.trim() || undefined,
        company: company.trim() || undefined,
        goal: goal.trim() || undefined,
        consent: true,
        challengeToken: challenge.token,
        challengeAnswer: answer,
      });
      setReceipt(answerReceipt);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const apiError = toApiError(caught);
      setSubmitError(apiError);
      // A challenge-invalid / challenge-unsolved 400 means this challenge is
      // spent either way; minting a fresh one is the documented recovery, and
      // it is offered rather than done silently behind the operator's back.
      if (apiError.kind === 'invalid') setExpired(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (receipt) {
    return (
      <PublicShell contextLabel="Diagnostic request">
        <Receipt receipt={receipt} />
      </PublicShell>
    );
  }

  return (
    <PublicShell contextLabel="Diagnostic request">
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-title font-semibold tracking-tight">Request a diagnostic</h1>
          <p className="text-table text-muted-foreground">
            Tell us the site and what you are trying to achieve. You get a receipt
            for the request, and a person picks it up from there.
          </p>
        </header>

        {challengeError ? (
          <ErrorState
            error={challengeError}
            onRetry={challengeError.kind === 'unavailable' ? undefined : () => void loadChallenge()}
            providerName="the request intake"
          />
        ) : challengeLoading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : (
          <Card>
            <CardContent className="space-y-3 py-4">
              <div className="flex items-start gap-2">
                <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 text-muted-foreground" />
                <div className="space-y-1">
                  <div className="text-table font-medium">This form asks for a small amount of work</div>
                  <p className="text-meta text-muted-foreground">
                    It is not a CAPTCHA and not a third-party widget. Your browser
                    has to find a value whose hash meets a difficulty issued by the
                    server, which is a real cost per submission and keeps bulk
                    scripts out of a queue that a person has to read.
                  </p>
                  {expired ? (
                    <p className="text-meta text-warning">
                      The current challenge has expired or has already been used.
                      Get a new one to submit.
                    </p>
                  ) : challenge ? (
                    <p className="text-meta text-muted-foreground">
                      Challenge expires <Timestamp value={challenge.expiresAt} />.
                    </p>
                  ) : null}
                </div>
              </div>
              {expired ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadChallenge()}
                >
                  Get a new challenge
                </Button>
              ) : null}
            </CardContent>
          </Card>
        )}

        {/* §3.4 — a failed submit reports its fields and links to them. */}
        {submitError ? (
          <ErrorState
            error={submitError}
            layout="inline"
            onRetry={submitError.kind === 'rate-limited' ? undefined : () => setSubmitError(null)}
            preserveNotice="Nothing was submitted twice and your answers are still on this page."
          />
        ) : null}

        <form onSubmit={onSubmit} noValidate className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="field-domain">Domain</Label>
            <Input
              id="field-domain"
              name="domain"
              inputMode="url"
              autoComplete="url"
              placeholder="example.com"
              required
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              disabled={submitting}
            />
            <p className="text-meta text-muted-foreground">
              Required. A URL or a bare host both work; it is normalised to the
              site&apos;s own host.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="field-contactEmail">Email address</Label>
            <Input
              id="field-contactEmail"
              name="contactEmail"
              type="email"
              autoComplete="email"
              required
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
              disabled={submitting}
            />
            <p className="text-meta text-muted-foreground">
              Required. Where the reply goes.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="field-contactName">Your name (optional)</Label>
              <Input
                id="field-contactName"
                name="contactName"
                autoComplete="name"
                maxLength={120}
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="field-company">Company (optional)</Label>
              <Input
                id="field-company"
                name="company"
                autoComplete="organization"
                maxLength={200}
                value={company}
                onChange={(event) => setCompany(event.target.value)}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="field-goal">What are you trying to achieve?</Label>
            <Textarea
              id="field-goal"
              name="goal"
              rows={4}
              maxLength={2000}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              disabled={submitting}
              placeholder="Optional, but it is the first question whoever picks this up will ask."
            />
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id="field-consent"
              checked={consent}
              onCheckedChange={(checked) => setConsent(checked === true)}
              disabled={submitting}
              aria-describedby="consent-help"
            />
            <div className="space-y-1">
              <Label htmlFor="field-consent">Required: agree to be contacted</Label>
              <p id="consent-help" className="text-meta text-muted-foreground">
                “{CONSENT_STATEMENT}” The request is refused without this — the
                record exists because you agreed to it.
              </p>
            </div>
          </div>

          <Alert>
            <AlertTitle>What this request does</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-5">
                <li>It records your domain, contact details and goal for a person to review.</li>
                <li>
                  It does <strong>not</strong> fetch your site, crawl it or run any
                  audit. The expensive work happens operator-side, deliberately.
                </li>
                <li>It costs nothing and commits you to nothing.</li>
              </ul>
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? 'Submitting…' : 'Request the diagnostic'}
            </Button>
            {submitting ? (
              <span className="text-meta text-muted-foreground" role="status">
                {hashesTried > 0
                  ? `Solving the challenge — ${hashesTried.toLocaleString()} candidate answers hashed so far.`
                  : 'Starting the challenge…'}
              </span>
            ) : null}
          </div>
        </form>

        <p className="text-meta text-muted-foreground">
          Already know what you need? <Link href="/sign-in" className="underline-offset-4 hover:text-foreground hover:underline">Sign in</Link>{' '}
          if you have an account, or share a{' '}
          <span className="font-mono">/shared/scorecards/…</span> link instead.
        </p>
      </div>
    </PublicShell>
  );
}

/** The submission receipt — what was recorded, and what happens next. */
function Receipt({ receipt }: { receipt: DiagnosticReceipt }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-success">
        <CheckCircle2 aria-hidden="true" className="h-5 w-5" />
        <span className="text-table font-medium">
          {receipt.duplicate ? 'Already received' : 'Request received'}
        </span>
      </div>

      <header className="space-y-2">
        <h1 className="text-title font-semibold tracking-tight">
          Thank you — your request is recorded
        </h1>
        <p className="text-table text-muted-foreground">{receipt.nextStep}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Receipt</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-table">
            <div className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">Receipt</dt>
              <dd className="font-mono text-meta">{receipt.receiptId}</dd>
            </div>
            <div className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">Site</dt>
              <dd className="font-mono text-meta">{receipt.domain}</dd>
            </div>
            <div className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">Reply to</dt>
              <dd>{receipt.contactEmail}</dd>
            </div>
            <div className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">Submitted</dt>
              <dd>
                <Timestamp value={receipt.submittedAt} />
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">Queue state</dt>
              <dd>
                {receipt.status === 'queued'
                  ? 'Queued for an operator.'
                  : 'Recorded against a request that was already queued.'}
              </dd>
            </div>
          </dl>

          {receipt.runNotStartedReason ? (
            <p className="mt-4 text-meta text-muted-foreground">
              The request is stored, but no background run was started: {receipt.runNotStartedReason}{' '}
              A person still sees it in the queue.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <p className="text-table text-muted-foreground">
        Keep the receipt id above. If nothing arrives, quote it and whoever sent
        you here can find the request without searching by domain.
      </p>

      <p className="text-meta text-muted-foreground">
        Nothing has been bought, and no audit has been run yet. A person reviews
        the request first — that is deliberate, and it is why this form does not
        hand you a score.
      </p>
    </div>
  );
}
