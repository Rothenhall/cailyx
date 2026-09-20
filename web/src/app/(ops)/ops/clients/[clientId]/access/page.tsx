'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { getClient, createClientLogin } from '@/services/clients';
import type { ClientDetail } from '@/services/types';

/**
 * OP08 — Client access.
 *
 * design_plan.md §4.2: *"Create login; one-time password handoff and email
 * result; target seat list/invites/revoke"*, support "P: create login E;
 * lifecycle G01/G02".
 *
 * Two rules from §11.2 case 2 govern this file, and both are easy to get
 * wrong in the same direction — by making the screen look tidier than the
 * truth:
 *
 *  1. **The temporary password is shown exactly once.** The backend returns it
 *     from the create call and stores only a hash. It is rendered in a
 *     labelled, copyable block with an explicit statement that leaving the page
 *     loses it, and the create action is **never** re-issued to try to get it
 *     back — a second attempt cannot return the first password, it can only
 *     fail with "email already registered".
 *  2. **The email result is reported separately from the account.** When Plunk
 *     delivery fails, the account still exists, and §11.2 case 2 requires the UI
 *     to keep showing that. So "Account created" and "Email delivered" are two
 *     separate facts on this page, and a failed email never renders as a failed
 *     creation. The failure produces a handoff the operator can copy by hand
 *     instead — which is what the backend's own doc comment says to do.
 *
 * The third part of §4.2 — "seat list/invites/revoke" — has no endpoint: there
 * is no route that lists a client's logins, and no invite or revoke action.
 * That is G01/G02, and it is stated here rather than implied by an empty list,
 * because "this client has no logins" and "this page cannot see the logins" are
 * different facts and only one of them is true.
 *
 * DEPRECATED FLOW (2026-09-20, `docs/analysis/client-portal.md` §2, `docs/PLAN.md`
 * §11.0): `POST /clients/:clientId/login` — the temp-password endpoint this page
 * calls — is no longer the canonical way to grant portal access. The invite-link
 * flow (`POST /clients/:clientId/invites`, `client-access` module — single-use
 * 7-day link, client sets their own password) is canonical now. This page is kept
 * working as a non-default escape hatch (there is no ops-side invite UI yet — G02's
 * invite/seat management screens are a separate, not-yet-built piece of work), but
 * it must not be presented or used as the default path. See the in-page warning
 * banner below.
 */
export default function ClientAccessPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params.clientId;

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** The create result. Once set, the form is sealed — see rule 1 above. */
  const [created, setCreated] = useState<{
    email: string;
    temporaryPassword: string;
    emailSent: boolean;
    emailError: string | null;
  } | null>(null);

  const [origin, setOrigin] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        setLoading(true);
        const detail = await getClient(clientId, { signal });
        setClient(detail);
        // Prefill from the contact on file — a real value, not a placeholder.
        if (detail.contactEmail) setEmail((current) => current || detail.contactEmail || '');
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    // Read after mount so the handoff message never disagrees between the
    // server render and the client render.
    setOrigin(window.location.origin);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A second submit cannot produce a second account and must not try.
    if (submitting || created) return;

    setSubmitError(null);
    setFieldErrors(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFieldErrors({ email: ['Enter the email address the client will sign in with.'] });
      setSubmitError('Enter an email address before creating the login.');
      focusField('email');
      return;
    }

    setSubmitting(true);
    try {
      const result = await createClientLogin(clientId, {
        email: trimmedEmail,
        name: name.trim() || trimmedEmail,
      });
      setCreated({
        email: result.email,
        temporaryPassword: result.temporaryPassword,
        emailSent: result.emailSent,
        emailError: result.emailError ?? null,
      });
    } catch (caught) {
      const error = toApiError(caught);
      setFieldErrors(error.fieldErrors ?? null);
      setSubmitError(
        error.kind === 'conflict'
          ? 'That email address already has an account. Nothing was created. If the person needs access, use the account-recovery flow rather than creating a second login.'
          : 'The login was not created. Nothing was saved, and no email was sent.',
      );
      if (error.fieldErrors) focusField(Object.keys(error.fieldErrors)[0]);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }]} title="Client access" />
        <ErrorState error={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  if (!client) return null;

  const handoffMessage = created
    ? [
        `Your client portal login is ready.`,
        ``,
        `Sign in at: ${origin || '(this site)'}/sign-in`,
        `Email: ${created.email}`,
        `Temporary password: ${created.temporaryPassword}`,
        ``,
        `You will be asked to choose your own password after signing in.`,
      ].join('\n')
    : '';

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Clients', href: '/ops/clients' },
          { label: client.name, href: `/ops/clients/${client.id}` },
          { label: 'Access' },
        ]}
        title="Client access"
        context={`Portal logins for ${client.name}`}
      />

      <Alert>
        <AlertTitle>This temporary-password flow is deprecated</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            The invite-link flow (single-use link, client sets their own password) is now the
            canonical way to grant portal access — see `docs/analysis/client-portal.md` §2. This
            page is kept working as a non-default escape hatch only, because there is no ops-side
            invite UI yet. Prefer creating an invite via the API (
            <code className="text-meta">POST /clients/:clientId/invites</code>) when possible.
          </p>
        </AlertDescription>
      </Alert>

      {created ? (
        <CreatedPanel
          created={created}
          handoffMessage={handoffMessage}
          origin={origin}
          clientId={client.id}
          onAddAnother={() => {
            setCreated(null);
            setEmail('');
            setName('');
            setSubmitError(null);
            setFieldErrors(null);
          }}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Create a portal login</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-table text-muted-foreground">
              Creates a client-type account attached to <strong className="font-medium text-foreground">{client.name}</strong>.
              It can read only this client&apos;s own projects, reports and messages. The temporary
              password is generated by the server and returned exactly once.
            </p>

            {submitError ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Not created</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{submitError}</p>
                  {fieldErrors ? (
                    <ul className="list-inside list-disc space-y-1">
                      {Object.entries(fieldErrors).map(([field, messages]) => (
                        <li key={field}>
                          <a href={`#${field}`} className="underline underline-offset-4">
                            {messages.join(' ')}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">
                  Email address
                  <span className="ml-1 text-meta font-normal text-muted-foreground">(required)</span>
                </Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  disabled={submitting}
                  aria-invalid={fieldErrors?.email ? true : undefined}
                  aria-describedby={fieldErrors?.email ? 'email-error' : 'email-help'}
                />
                {fieldErrors?.email ? (
                  <p id="email-error" className="text-meta text-danger-foreground">
                    {fieldErrors.email.join(' ')}
                  </p>
                ) : (
                  <p id="email-help" className="text-meta text-muted-foreground">
                    This is the login itself. An address that already has an account is rejected —
                    one account per address.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="name">Display name</Label>
                <Input
                  id="name"
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={submitting}
                  aria-describedby="name-help"
                />
                <p id="name-help" className="text-meta text-muted-foreground">
                  Defaults to the email address when left blank.
                </p>
              </div>

              <Button type="submit" disabled={submitting || !email.trim()}>
                {submitting ? 'Creating login…' : 'Create login'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Seats, invitations and revocation</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            variant="not-measured"
            subject="this client's login list"
            prerequisite="a seat/invitation API (design_plan G01/G02)"
            layout="panel"
          >
            <p>
              There is no endpoint that lists a client&apos;s logins, so this page cannot show who
              currently has access, when they were invited, or whether an invitation is pending.
              Nothing is implied by the absence of a list here — it is unreadable, not empty.
            </p>
            <p>
              Revoking or re-issuing access for an existing account is likewise unavailable. Those
              actions are tracked as G01/G02; until they exist, access changes are made by an
              administrator outside this screen.
            </p>
            <p>
              To check whether a login was created in this session, the confirmation stays on this
              page until you add another. After you leave, the password it showed is gone — the
              server stores only a hash.
            </p>
          </EmptyState>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The confirmation, which is the whole reason this screen exists.
 *
 * The order is deliberate: what exists, then the password (with its one-time
 * warning), then whether the email arrived. A reader skimming the top must not
 * come away thinking a failed email means a failed account.
 */
function CreatedPanel({
  created,
  handoffMessage,
  origin,
  clientId,
  onAddAnother,
}: {
  created: {
    email: string;
    temporaryPassword: string;
    emailSent: boolean;
    emailError: string | null;
  };
  handoffMessage: string;
  origin: string;
  clientId: string;
  onAddAnother: () => void;
}) {
  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Account created</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            <strong className="font-medium">{created.email}</strong> now has a portal login for this
            client. The account exists and can sign in — independently of whether the notification
            email below arrived.
          </p>
          <p className="text-meta">
            Do not submit the form again to make the email resend. Account creation is not
            repeatable: a second attempt is rejected because the address already has an account, and
            it cannot return this password a second time.
          </p>
        </AlertDescription>
      </Alert>

      <OneTimeSecret
        label="Temporary password"
        value={created.temporaryPassword}
        warning="This is the only time it will be shown. The server stores only a hash of it, so it cannot be retrieved, re-sent or looked up later — not by you and not by an administrator."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Email delivery</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {created.emailSent ? (
            <>
              <p className="text-table">
                The server reported the notification email to{' '}
                <strong className="font-medium">{created.email}</strong> as sent.
              </p>
              <p className="text-meta text-muted-foreground">
                &ldquo;Sent&rdquo; is the mail provider accepting the message, not a record of it
                being delivered or read. If the person does not receive it, hand the password over
                directly using the message below.
              </p>
            </>
          ) : (
            <>
              <p className="text-table">
                The notification email was{' '}
                <strong className="font-medium text-danger-foreground">not sent</strong>. The
                account was still created — those are two separate results, and only the email
                failed.
              </p>
              {created.emailError ? (
                <p className="text-meta text-muted-foreground">
                  The server reported: {created.emailError}
                </p>
              ) : null}
              <p className="text-meta text-muted-foreground">
                There is no &ldquo;resend&rdquo; action for this email, and re-creating the account
                is not a way to retry it. Hand the password over yourself.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Handoff message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-table text-muted-foreground">
            Copy this and send it to <strong className="font-medium text-foreground">{created.email}</strong> through a
            channel you already trust. It contains the password, so treat it as sensitive.
          </p>
          <CopyBlock
            label="Handoff message"
            value={handoffMessage}
            display={handoffMessage}
            warning="Send this over a channel you control. Anyone with it can sign in as this client until the password is changed."
          />
          {origin ? (
            <p className="text-meta text-muted-foreground">
              Sign-in page: <span className="font-mono">{origin}/sign-in</span>
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">If the password is lost before it is handed over</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-table text-muted-foreground">
          <p>
            The account holder can request a reset themselves from the sign-in screen
            (<code className="text-meta">POST /api/auth/password/forgot</code>). That route exists and
            is public.
          </p>
          <p>
            Be aware it depends on the same mail delivery that just failed. If the email could not be
            sent above, treat the reset route as unverified rather than assuming it will reach them.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href={`/ops/clients/${clientId}`}>Back to the client</Link>
        </Button>
        <Button variant="outline" onClick={onAddAnother}>
          Create another login
        </Button>
      </div>
    </div>
  );
}

/**
 * A value that exists on this page exactly once.
 *
 * `display` is separated from `value` so the handoff message can be shown as a
 * wrapped block while the copy action copies the exact text. Nothing here is
 * ever put in a URL, a log or a link — the block is plain text by construction.
 */
function OneTimeSecret({
  label,
  value,
  warning,
}: {
  label: string;
  value: string;
  warning: string;
}) {
  return (
    <Card className="border-warning">
      <CardHeader>
        <CardTitle className="text-subsection">{label} — shown once</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <CopyBlock label={label} value={value} display={value} warning={warning} mono />
      </CardContent>
    </Card>
  );
}

function CopyBlock({
  label,
  value,
  display,
  warning,
  mono = false,
}: {
  label: string;
  value: string;
  display: string;
  warning: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function onCopy() {
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // A blocked clipboard is a real possibility; selecting the text by hand
      // is the fallback and the block stays selectable for exactly that.
      setCopyFailed(true);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        <pre
          className={
            mono
              ? 'min-w-0 flex-1 overflow-x-auto rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-body font-mono text-foreground'
              : 'min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-table text-foreground'
          }
        >
          {display}
        </pre>
        <Button type="button" variant="outline" onClick={() => void onCopy()}>
          {copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
        </Button>
      </div>
      {copied ? (
        <p className="text-meta text-muted-foreground" role="status">
          Copied to the clipboard.
        </p>
      ) : null}
      {copyFailed ? (
        <p className="text-meta text-warning-foreground" role="status">
          The clipboard could not be used in this browser. Select the text above and copy it by
          hand — it is displayed in full.
        </p>
      ) : null}
      <p className="text-meta text-warning-foreground">{warning}</p>
    </div>
  );
}

function focusField(name: string) {
  if (typeof document === 'undefined') return;
  const element = document.getElementById(name);
  if (element instanceof HTMLElement) element.focus();
}
