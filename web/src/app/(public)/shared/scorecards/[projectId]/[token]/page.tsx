'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PublicShell } from '@/components/layouts/PublicShell';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { ApiError } from '@/lib/api';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  captureScorecardCta,
  getPublicScorecard,
  SharedScorecardMismatch,
  type PublicScorecard,
} from '@/services/shared';

/**
 * PB02 — Shared scorecard.
 *
 * design_plan.md §4.1: *"Score, coverage disclaimer, exactly three problems,
 * clear CTA"*; §6.1 names the same four things as the initial scorecard's
 * required content. This is the lead-facing rung-0 page: someone who is not a
 * client opened a link and gets one score, three named problems and one way
 * forward.
 *
 * Four rules shape it:
 *
 *  1. **The token is the credential, and the URL's project id is only a
 *     check.** The read is scoped by the token server-side. If the token
 *     resolves to a different project than the URL claims, this page renders
 *     the same neutral "no scorecard" state it shows for an unknown token,
 *     so a guessed or edited project id reveals nothing.
 *
 *  2. **The coverage caveat is not optional.** A scorecard is a low-depth
 *     automated check, not a full audit. The score is presented with what it
 *     was measured from, and no figure on this page is dressed up as more than
 *     that.
 *
 *  3. **Exactly three problems — and "three" is stated, not implied.** If the
 *     server returns fewer, the page says so rather than padding the list or
 *     presenting a short list as complete.
 *
 *  4. **A CTA click here records a click, not a purchase or a promise.** The
 *     capture route writes a lead event; the real next step is the diagnostic
 *     request, which is a separate form with its own consent gate.
 *
 * A 403 means the public scorecard funnel is switched off entirely — that is an
 * explicit unavailable state, and the page does not offer a retry for it,
 * because retrying cannot change a configuration decision (§3.5).
 */
export default function SharedScorecardPage() {
  const params = useParams<{ projectId: string; token: string }>();
  const { projectId, token } = params;

  const [scorecard, setScorecard] = useState<PublicScorecard | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setScorecard(await getPublicScorecard(projectId, token, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof SharedScorecardMismatch) {
          // The token belongs to another project. Same answer as an unknown
          // token: this link does not have a scorecard.
          setError(
            new ApiError({
              kind: 'not-found',
              status: 404,
              message: 'This link does not open a scorecard.',
            }),
          );
          return;
        }
        setError(toApiError(caught));
      }
    },
    [projectId, token],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <PublicShell contextLabel="Shared scorecard">
        <ErrorState
          error={error}
          onRetry={error.kind === 'forbidden' ? undefined : () => void load()}
          notFoundReason="missing"
          restrictedAction="open this scorecard"
          permittedPath="Ask whoever sent you the link for a current one, or request a diagnostic directly."
        />
      </PublicShell>
    );
  }

  if (!scorecard) {
    return (
      <PublicShell contextLabel="Shared scorecard">
        <div className="space-y-6">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </PublicShell>
    );
  }

  // "Exactly three" is the contract. Render what exists and say plainly when
  // the server returned fewer, rather than presenting a short list as complete.
  const problems = scorecard.problems.slice(0, 3);
  const isLowDepth = scorecard.depth !== 'operator';

  return (
    <PublicShell contextLabel="Shared scorecard">
      <div className="space-y-6">
        {/* The scorecard row carries no client or domain, so the banner states
            the mode and nothing it cannot substantiate. */}
        <ScopeBanner
          scope={{
            mode: 'snapshot',
            snapshotLabel: `Scorecard run ${new Date(scorecard.createdAt).toLocaleDateString()}`,
          }}
        />

        <header className="space-y-2">
          <h1 className="text-title font-semibold tracking-tight">
            AI visibility scorecard
          </h1>
          <p className="text-table text-muted-foreground">
            An automated first look at how findable and clearly described this
            site is. Prepared{' '}
            <Timestamp value={scorecard.createdAt} dateOnly />.
          </p>
        </header>

        <Card>
          <CardContent className="flex flex-wrap items-end gap-x-8 gap-y-4 py-6">
            <div>
              <div className="text-meta text-muted-foreground">Overall score</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-kpi font-semibold tabular-nums">
                  {Number.isFinite(scorecard.score)
                    ? formatNumber(scorecard.score)
                    : notMeasuredLabel()}
                </span>
                <span className="text-table text-muted-foreground">of 100</span>
              </div>
            </div>
            <div>
              <div className="text-meta text-muted-foreground">Band</div>
              <div className="mt-1 text-subsection font-medium">{scorecard.band}</div>
            </div>
            <div>
              <div className="text-meta text-muted-foreground">Check depth</div>
              <div className="mt-1 text-subsection font-medium">
                {scorecard.depth === 'operator' ? 'Operator run' : 'Free — limited depth'}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* The coverage caveat, before the problems it qualifies (§6.1). */}
        <Alert>
          <AlertTitle>What this score does and does not cover</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              This is a single automated check of publicly visible signals, run
              at {isLowDepth ? 'limited' : 'operator'} depth. It is not a full
              audit.
            </p>
            <p>
              The band is a rubric label, not a promise.{' '}
              {scorecard.band.toLowerCase() === 'recommended'
                ? '“Recommended” means the rubric places this site in its top band — it is not a claim that any search engine or AI assistant recommends the brand.'
                : 'A band describes where this site sits on the measured signals only.'}
            </p>
            <p>
              Anything not listed below was either not measurable from outside or
              not measured in this run. It has not been assessed as fine.
            </p>
          </AlertDescription>
        </Alert>

        <section className="space-y-3">
          <h2 className="text-subsection font-semibold">
            The three highest-priority problems
          </h2>
          {problems.length === 0 ? (
            <p className="text-table text-muted-foreground">
              This run recorded no named problems. That means the check found
              nothing it could name — not that there is nothing to fix.
            </p>
          ) : (
            <>
              {problems.length < 3 ? (
                <p className="text-table text-muted-foreground">
                  This run returned {problems.length} named problem
                  {problems.length === 1 ? '' : 's'}, not the usual three. The
                  check could not name more from what it could see.
                </p>
              ) : null}
              <ol className="space-y-3">
                {problems.map((problem, index) => (
                  <li key={`${problem.dimension}-${index}`}>
                    <Card>
                      <CardHeader>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <CardTitle className="text-subsection">
                            <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                            {problem.dimension}
                          </CardTitle>
                          <span className="text-meta text-muted-foreground">
                            {typeof problem.value === 'number'
                              ? `dimension score ${formatNumber(problem.value)}/100`
                              : `dimension ${notMeasuredLabel()}`}
                          </span>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div>
                          <div className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
                            What was observed
                          </div>
                          <p className="mt-1 text-body leading-relaxed">{problem.why}</p>
                        </div>
                        <div>
                          <div className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
                            What to do about it
                          </div>
                          <p className="mt-1 text-body leading-relaxed">{problem.fix}</p>
                        </div>
                        {problem.evidence.length > 0 ? (
                          <div>
                            <div className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
                              Evidence from the check
                            </div>
                            <ul className="mt-1 list-disc space-y-1 pl-5 text-table text-muted-foreground">
                              {problem.evidence.map((line) => (
                                <li key={line} className="break-words">
                                  {line}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ol>
            </>
          )}

          {scorecard.nonObvious ? (
            <p className="text-meta text-muted-foreground">
              At least one of these is something you could not have seen without
              this check.
            </p>
          ) : null}
        </section>

        <ScorecardCta token={token} />
      </div>
    </PublicShell>
  );
}

/**
 * The call to action.
 *
 * Two routes forward, and they are deliberately different things: the request
 * form is the real funnel (it creates a project stub and a receipt), while the
 * email capture only logs a CTA event against this scorecard so somebody can
 * follow up. Neither grants anything, and the copy says which is which.
 */
function ScorecardCta({ token }: { token: string }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nextStep, setNextStep] = useState<string | null>(null);
  const [ctaError, setCtaError] = useState<ApiError | null>(null);

  const canSubmit = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && consent && !submitting;

  async function onSubmitCta(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setCtaError(null);
    try {
      const answer = await captureScorecardCta(token, {
        type: 'book-call',
        email: email.trim(),
        name: name.trim() || undefined,
        consent: true,
      });
      setNextStep(answer.nextStep);
    } catch (caught) {
      setCtaError(toApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">What happens next</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-table">
            The useful next step is a full diagnostic: a proper technical audit,
            the gaps this scorecard could not see, and a prioritised plan.
          </p>
          <Button asChild>
            <Link href="/request-audit">Request a full diagnostic</Link>
          </Button>
          <p className="text-meta text-muted-foreground">
            That form asks for your domain, a contact address and what you are
            trying to achieve, and gives you a receipt for the request.
          </p>
        </div>

        <div className="space-y-3 border-t border-border pt-5">
          {nextStep ? (
            <div className="flex items-start gap-2">
              <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 text-success" />
              <div>
                <div className="text-table font-medium">Recorded</div>
                <p className="mt-1 text-table text-muted-foreground">{nextStep}</p>
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmitCta} noValidate className="space-y-3">
              <div>
                <h3 className="text-table font-medium">
                  Rather talk it through? Ask for a call.
                </h3>
                <p className="mt-1 text-meta text-muted-foreground">
                  This records your interest against this scorecard. It does not
                  book a time and it does not start any work.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cta-email">Email address</Label>
                <Input
                  id="cta-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cta-name">Name (optional)</Label>
                <Input
                  id="cta-name"
                  name="name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div className="flex items-start gap-3">
                <Checkbox
                  id="cta-consent"
                  checked={consent}
                  onCheckedChange={(checked) => setConsent(checked === true)}
                />
                <div className="space-y-1">
                  <Label htmlFor="cta-consent">
                    You may contact me about this scorecard
                  </Label>
                  <p className="text-meta text-muted-foreground">
                    Required — the record exists because you agreed to it, so the
                    form does not accept an address without it.
                  </p>
                </div>
              </div>

              <Button type="submit" variant="outline" disabled={!canSubmit}>
                {submitting ? 'Sending…' : 'Ask for a call'}
              </Button>
            </form>
          )}

          {ctaError ? (
            <ErrorState
              error={ctaError}
              layout="inline"
              onRetry={() => setCtaError(null)}
              preserveNotice="Nothing was recorded; your details are still in the form."
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
