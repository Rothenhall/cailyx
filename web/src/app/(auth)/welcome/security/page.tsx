'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Info, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useSession } from '@/hooks/useSession';
import { ApiError } from '@/lib/api';
import { changePassword, requestPasswordReset, updateOwnName } from '@/services/account';

/**
 * AU04 — First-login security.
 *
 * design_plan.md §4.1: *"Replace temporary password; confirm name; recovery
 * setup"*, in the Access-forms layout family (§4), and it is where AU01 sends
 * anyone whose account carries `mustChangePassword`.
 *
 * Three steps, and each one is honest about what the API can actually do:
 *
 *  1. **Replace the temporary password** — real, via
 *     `POST /auth/password/change`, which also revokes every *other* live
 *     session and clears the forced-change flag. The number of sessions that
 *     revocation killed is reported, because "your other sessions were ended"
 *     is a fact the person should be told rather than left to discover.
 *
 *  2. **Confirm the name** — read from the session; editable only for an
 *     admin, because `PATCH /users/:id` is admin-only and there is no
 *     self-service profile route. A non-admin is told that plainly instead of
 *     being offered a field that would 403.
 *
 *  3. **Recovery setup** — this is the step with no endpoint behind it. There
 *     is no route to register a recovery phone, a backup address or recovery
 *     codes; what exists is the emailed reset link (G01), which is why the
 *     email address on the account is shown as the single recovery fact, with
 *     the consequence stated.
 *
 * A **client-type** session reaches this page too (AU01 routes
 * `mustChangePassword` accounts here regardless of type) and cannot complete
 * step 1: the whole `/auth/*` password surface is operator-only, and
 * RolesGuard denies a client token on any route that is not marked
 * `@ClientPortal()`. That is rendered as an explicit unavailable state with the
 * one path that does work — a reset link from the public recovery form — rather
 * than as a form that fails on submit.
 */
export default function FirstLoginSecurityPage() {
  const { user, status, refresh, signOut } = useSession();
  const router = useRouter();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-md space-y-4">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    );
  }

  if (status === 'anonymous' || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-sm">
          <h1 className="text-title font-semibold tracking-tight">Security setup</h1>
          <p className="mt-2 text-table text-muted-foreground">
            This page changes the password on your account, so it needs you to be
            signed in first.
          </p>
          <Button asChild className="mt-6 w-full">
            <Link href="/sign-in">Go to sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  const isClientAccount = user.type === 'client';

  return (
    <div className="flex min-h-screen justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div>
          <div className="text-subsection font-semibold tracking-tight">Cailyx</div>
          <h1 className="mt-6 text-title font-semibold tracking-tight">
            Secure your account
          </h1>
          <p className="mt-1.5 text-table text-muted-foreground">
            Your account was created with a temporary password. Replace it before
            you carry on — until you do, anyone holding that password can sign in
            as you.
          </p>
        </div>

        {isClientAccount ? <ClientPasswordUnavailable email={user.email} onSignOut={signOut} /> : <PasswordStep onDone={refresh} />}

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Confirm your name</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <NameStep
              userId={user.id}
              initialName={user.name}
              isAdmin={user.role === 'admin'}
              onSaved={refresh}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Recovery</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-2">
              <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div className="space-y-1">
                <div className="text-table font-medium">
                  Recovery is by emailed reset link
                </div>
                <p className="text-table text-muted-foreground">
                  If you lose this password, a single-use link is sent to{' '}
                  <span className="font-mono">{user.email}</span>. It expires in one
                  hour, works once, and using it ends every session on the
                  account.
                </p>
                <p className="text-meta text-muted-foreground">
                  Make sure you can reach that address. There is no route in this
                  build to add a recovery phone number, a backup address or
                  recovery codes — changing the address itself is an
                  administrator action.
                </p>
              </div>
            </div>
            <p className="text-meta text-muted-foreground">
              Account created <Timestamp value={user.createdAt} dateOnly />.
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => router.push(isClientAccount ? '/client' : '/ops')}>
            {isClientAccount ? 'Continue to the portal' : 'Continue to the workspace'}
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Step 1 for an operator account. */
function PasswordStep({ onDone }: { onDone: () => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sessionsRevoked, setSessionsRevoked] = useState<number | null>(null);

  const tooShort = newPassword.length > 0 && newPassword.length < 10;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit =
    !submitting &&
    currentPassword.length > 0 &&
    newPassword.length >= 10 &&
    confirmPassword === newPassword;

  const clearSecrets = useCallback(() => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await changePassword({ currentPassword, newPassword });
      setSessionsRevoked(result.sessionsRevoked);
      clearSecrets();
      await onDone();
    } catch (caught) {
      setError(toApiError(caught));
      // Never keep the secrets on a failure — a wrong current password is
      // still a password, and clearing removes it from the DOM.
      clearSecrets();
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionsRevoked !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Temporary password replaced</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
            <span className="text-table font-medium">Done</span>
          </div>
          <p className="text-table text-muted-foreground">
            {sessionsRevoked > 0
              ? `${sessionsRevoked} other session${sessionsRevoked === 1 ? '' : 's'} on this account were signed out. If you did not expect any, that is worth telling your administrator about.`
              : 'No other sessions were open, so nothing else had to be signed out. This session stays signed in.'}
          </p>
          <p className="text-meta text-muted-foreground">
            You can change it again at any time from{' '}
            <Link href="/account" className="underline-offset-4 hover:text-foreground hover:underline">
              your account
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Replace your temporary password</CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorState
            error={error}
            layout="inline"
            onRetry={() => setError(null)}
            fieldIdPrefix="field-"
            preserveNotice="Nothing was changed. Enter the passwords again to retry."
          />
        ) : null}

        <form onSubmit={onSubmit} noValidate className="mt-3 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="field-currentPassword">Current (temporary) password</Label>
            <Input
              id="field-currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={error?.kind === 'unauthenticated' ? true : undefined}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="field-newPassword">New password</Label>
            <Input
              id="field-newPassword"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={tooShort ? true : undefined}
              aria-describedby="new-password-help"
            />
            <p id="new-password-help" className="text-meta text-muted-foreground">
              Required. At least ten characters — the server refuses anything
              shorter, and it is stated here rather than discovered on submit.
              {tooShort ? <span className="text-danger"> Currently too short.</span> : null}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="field-confirmPassword">Confirm new password</Label>
            <Input
              id="field-confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={mismatch ? true : undefined}
              aria-describedby="confirm-password-help"
            />
            <p id="confirm-password-help" className="text-meta text-muted-foreground">
              Required.{' '}
              {mismatch ? (
                <span className="text-danger">The two passwords do not match.</span>
              ) : (
                'Replacing the password signs out every other device on this account.'
              )}
            </p>
          </div>

          <Button type="submit" disabled={!canSubmit}>
            {submitting ? 'Replacing…' : 'Replace password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Step 1 for a client-portal account, which cannot use it.
 *
 * Rendering the form anyway would be worse than useless: the submit would 403
 * every time, and a 403 on a password form reads as "you typed it wrong".
 */
function ClientPasswordUnavailable({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onRequestReset() {
    setSubmitting(true);
    setError(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Replace your temporary password</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert>
          <Info aria-hidden="true" className="h-4 w-4 text-warning" />
          <AlertTitle>This has to be done from the reset link</AlertTitle>
          <AlertDescription>
            Client portal accounts cannot change a password from inside the app:
            the password-change route is part of the operator authentication
            surface and refuses a client session. The supported path is the
            emailed, single-use reset link — the same one the sign-in page
            offers.
          </AlertDescription>
        </Alert>

        {sent ? (
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
            <span className="text-table font-medium">
              If that address has an account, a reset link has been sent to it.
            </span>
          </div>
        ) : (
          <>
            <p className="text-table text-muted-foreground">
              Send a reset link to <span className="font-mono">{email}</span>. It
              expires in one hour and can only be used once; using it ends every
              session, so you will sign in again with the new password.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void onRequestReset()} disabled={submitting}>
                {submitting ? 'Sending…' : 'Send the reset link'}
              </Button>
              <Button variant="outline" onClick={() => void onSignOut()}>
                Sign out
              </Button>
            </div>
          </>
        )}

        {error ? (
          <ErrorState error={error} layout="inline" onRetry={() => setError(null)} />
        ) : null}

        <p className="text-meta text-muted-foreground">
          Ask your delivery lead if the temporary password cannot be replaced this
          way — they can confirm the address on the account, which this page
          deliberately cannot.
        </p>
      </CardContent>
    </Card>
  );
}

/** Step 2 — the name on the account. */
function NameStep({
  userId,
  initialName,
  isAdmin,
  onSaved,
}: {
  userId: string;
  initialName: string;
  isAdmin: boolean;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  const unchanged = name.trim() === initialName.trim();
  const tooShort = name.trim().length > 0 && name.trim().length < 2;

  async function onSave() {
    if (!isAdmin || unchanged || tooShort || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateOwnName(userId, name.trim());
      setSaved(true);
      await onSaved();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className="space-y-2">
        <div className="text-table">
          We have you as <span className="font-medium">{initialName || 'no name recorded'}</span>.
        </div>
        <p className="text-meta text-muted-foreground">
          Changing the name on an operator account is an administrator action in
          this build — there is no self-service profile edit, so this field is
          read-only here. Ask an administrator if it is wrong.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="field-name">Your name</Label>
        <Input
          id="field-name"
          name="name"
          autoComplete="name"
          minLength={2}
          maxLength={120}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          disabled={saving}
          aria-invalid={tooShort ? true : undefined}
          aria-describedby="name-help"
        />
        <p id="name-help" className="text-meta text-muted-foreground">
          This is what appears against your work and decisions. At least two
          characters.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={() => void onSave()}
          disabled={saving || unchanged || tooShort}
        >
          {saving ? 'Saving…' : 'Save name'}
        </Button>
        {saved ? (
          <span className="flex items-center gap-1.5 text-meta text-success">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
            Saved.
          </span>
        ) : null}
      </div>
      {error ? <ErrorState error={error} layout="inline" onRetry={() => setError(null)} /> : null}
    </div>
  );
}
