'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toApiError } from '@/components/patterns/ErrorState';
import { acceptInvite, type ClientMember } from '@/services/account';

/**
 * AU02 — Accept invitation.
 *
 * design_plan.md §4.1: *"Organization/client identity, invitation expiry, set
 * password, accept terms if product requires them"*, in the Access-forms layout
 * family (§4): centered narrow form, identity/context first, fields second,
 * single submit, inline validation plus summary, non-secret inputs preserved
 * after failure.
 *
 * **What this page can and cannot show is dictated by the backend, and the
 * page says so rather than filling the gap.** The only unauthenticated route in
 * the client-access module is `POST /invites/:token/accept`; there is no
 * token-preview read, so before acceptance the server will not resolve the
 * token to the organization, the inviter or the expiry. Those three facts are
 * rendered as an explicit unavailable state naming the missing endpoint —
 * guessing them (or inventing plausible copy such as "Acme has invited you")
 * would be fabricating the one thing an invitee most needs to be true.
 *
 * **The scope of the invitation is not this form's to decide.** The grant —
 * client, seat role and project list — is read from the stored token row
 * server-side. This form collects a password and an optional display name and
 * nothing else; there is no field for a role, a client or a project, so a
 * tampered or replayed submission has nothing to widen.
 *
 * On success the route returns a session, and this app revokes it inside the
 * adapter rather than storing it: sessions live in HttpOnly cookies written by
 * a server route handler, and this route has none. The invitee signs in with
 * the password they just chose, which is stated on the confirmation panel so
 * the extra step does not read as a failure.
 */
export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<'password' | 'confirmPassword' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState<ClientMember | null>(null);

  const passwordTooShort = password.length > 0 && password.length < 8;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const canSubmit =
    !submitting &&
    password.length >= 8 &&
    confirmPassword === password &&
    !passwordTooShort;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setError(null);
    setFieldError(null);
    setSubmitting(true);
    try {
      const result = await acceptInvite(token, {
        password,
        name: name.trim() || undefined,
      });
      setAccepted(result.member);
      setPassword('');
      setConfirmPassword('');
    } catch (caught) {
      const apiError = toApiError(caught);
      // §3.4 — the summary links to the field it concerns.
      if (apiError.kind === 'invalid') setFieldError('password');
      // 409 carries the meaningful cases: revoked, already accepted, expired,
      // or an email that already belongs to another account. The server's own
      // sentence is the one that tells the invitee what to do about it.
      setError(
        apiError.kind === 'not-found'
          ? 'This invitation link is not one we issued. Check the address used in the email, or ask for a new invitation.'
          : (apiError.message ||
              'The invitation could not be accepted. Ask your delivery lead for a new one.'),
      );
      setPassword('');
      setConfirmPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  if (accepted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 text-success">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5" />
            <span className="text-table font-medium">Invitation accepted</span>
          </div>
          <h1 className="text-title font-semibold tracking-tight">You are set up</h1>
          <p className="mt-2 text-table text-muted-foreground">
            Your access is active{accepted.name ? `, ${accepted.name}` : ''}. The
            invitation link cannot be used again.
          </p>
          <p className="mt-3 text-table text-muted-foreground">
            Sign in with the password you just set. This page does not sign you in
            by itself — sessions are created by the sign-in form, which is why the
            password you chose is the one you will use.
          </p>
          <Button asChild className="mt-6 w-full">
            <Link href="/sign-in">Continue to sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-subsection font-semibold tracking-tight">Cailyx</div>
          <h1 className="mt-6 text-title font-semibold tracking-tight">
            Accept your invitation
          </h1>
          <p className="mt-1.5 text-table text-muted-foreground">
            Choose a password to activate your client portal access.
          </p>
        </div>

        {/*
          Identity and expiry, which this page genuinely cannot read. Rendered
          as an explicit limitation rather than as invented copy.
        */}
        <Alert className="mb-4">
          <Info aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <AlertTitle>What this link is for is checked when you submit</AlertTitle>
          <AlertDescription>
            The organization this invitation belongs to, who sent it and when it
            expires are not shown here, because the API has no unauthenticated
            route that resolves an invitation without redeeming it. Your access is
            fixed by the invitation server-side — it comes from the token, not
            from anything on this form — and if the link has expired, been
            revoked, or already been used, submitting tells you so and nothing is
            created.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertCircle aria-hidden="true" className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Your name (optional)</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
            />
            <p className="text-meta text-muted-foreground">
              Shown to the team delivering your work. It can be changed later.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
                aria-invalid={passwordTooShort || fieldError === 'password' ? true : undefined}
                aria-describedby="password-help"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-sunken hover:text-foreground"
              >
                {showPassword ? (
                  <EyeOff aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <Eye aria-hidden="true" className="h-4 w-4" />
                )}
              </button>
            </div>
            <p id="password-help" className="text-meta text-muted-foreground">
              Required. At least eight characters.
              {passwordTooShort ? (
                <span className="text-danger"> Currently too short.</span>
              ) : null}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm password</Label>
            <Input
              id="confirm-password"
              name="confirmPassword"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={mismatch ? true : undefined}
              aria-describedby="confirm-help"
            />
            <p id="confirm-help" className="text-meta text-muted-foreground">
              Required.{' '}
              {mismatch ? (
                <span className="text-danger">The two passwords do not match.</span>
              ) : (
                'Type it again to catch a typo — there is no way to recover it from here except by email.'
              )}
            </p>
          </div>

          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {submitting ? 'Setting up your access…' : 'Set password and activate access'}
          </Button>
        </form>

        <p className="mt-6 text-meta text-muted-foreground">
          Problems with the link? Ask your delivery lead for a new invitation —
          they can see whether it is still open, which this page cannot.
        </p>
        <p className="mt-2 text-meta text-muted-foreground">
          Already activated?{' '}
          <Link
            href="/sign-in"
            className="underline-offset-4 hover:text-foreground hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
