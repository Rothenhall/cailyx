'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, LogOut, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { OpsShell } from '@/components/layouts/OpsShell';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useSession } from '@/hooks/useSession';
import { ApiError } from '@/lib/api';
import {
  changePassword,
  getProfile,
  listSessions,
  revokeSession,
  signOutEverywhere,
  updateOwnName,
  type SessionRow,
} from '@/services/account';

/**
 * AU05 — Account & sessions.
 *
 * design_plan.md §4.1: *"Name, password change, active sessions, sign out
 * everywhere, notification preferences"*.
 *
 * Two of the rules this screen has to get right are invisible when it works:
 *
 *  1. **Changing a password revokes the other sessions** (G01 behaviour). The
 *     count that revocation produced is rendered — "3 other sessions signed
 *     out" is information the person should have, and a silent revocation is
 *     how somebody concludes their account was compromised when it was not.
 *     This session survives, and the copy says so.
 *
 *  2. **"Sign out everywhere" is a server call, not a local cookie clear.** It
 *     revokes every refresh token on the account, including the one this
 *     browser holds. Clearing cookies alone would leave every other device
 *     signed in, so the server call goes first and the local session is
 *     cleared after it. The confirmation says the current device goes too,
 *     because that is the part people do not expect.
 *
 * Notification preferences are not on this page and never were: §4.1 lists them
 * under AU05's *target* scope with G08, and no route stores them. Rather than a
 * dead set of toggles, the absence is stated.
 *
 * Wrapped in `OpsShell` because there is no `(ops)` route-group layout to
 * inherit; the shell is the same one the rest of the operator surface uses, so
 * the navigation does not change shape on this route.
 */
export default function AccountPage() {
  return (
    <OpsShell>
      <Account />
    </OpsShell>
  );
}

function Account() {
  const { user, refresh, signOut } = useSession();
  const router = useRouter();

  const [profile, setProfile] = useState<{ name: string; role: string; email: string; createdAt: string } | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null);
  const [signOutAllOpen, setSignOutAllOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [me, sessionList] = await Promise.all([
          getProfile({ signal }),
          listSessions({ signal }),
        ]);
        setProfile({ name: me.name, role: me.role, email: me.email, createdAt: me.createdAt });
        setSessions(sessionList.sessions);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Account" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!profile || !sessions) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{profile.email}</span>
            <span className="text-meta text-muted-foreground">{profile.role}</span>
          </span>
        }
      />

      {notice ? (
        <Alert>
          <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <NameCard
        userId={user?.id ?? ''}
        profile={profile}
        isAdmin={profile.role === 'admin'}
        onSaved={async () => {
          await refresh();
          await load();
          setNotice('Your name was saved.');
        }}
      />

      <PasswordCard
        onChanged={async (revoked) => {
          await load();
          setNotice(
            revoked > 0
              ? `Password changed. ${revoked} other session${revoked === 1 ? '' : 's'} on this account were signed out.`
              : 'Password changed. No other sessions were open.',
          );
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Active sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            Every device currently signed in to this account. A session stays
            listed until it is revoked or expires.
          </p>

          <ul className="divide-y divide-border">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-table font-medium">
                      {session.deviceLabel ?? describeUserAgent(session.userAgent)}
                    </span>
                    {session.isCurrent ? (
                      <StatusPill label="This session" tone="info" />
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
                    <span>
                      Last seen <Timestamp value={session.lastSeenAt} />
                    </span>
                    <span>
                      Expires <Timestamp value={session.expiresAt} dateOnly />
                    </span>
                    {session.ipAddress ? (
                      <span className="font-mono">{session.ipAddress}</span>
                    ) : (
                      <span>Address not recorded</span>
                    )}
                  </div>
                </div>

                {session.isCurrent ? (
                  <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                    <LogOut aria-hidden="true" className="mr-2 h-4 w-4" />
                    Sign out
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRevokeTarget(session)}
                  >
                    <Trash2 aria-hidden="true" className="mr-2 h-4 w-4" />
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <div className="border-t border-border pt-4">
            <Button
              variant="outline"
              onClick={() => setSignOutAllOpen(true)}
              disabled={sessions.length === 0}
            >
              <LogOut aria-hidden="true" className="mr-2 h-4 w-4" />
              Sign out everywhere
            </Button>
            <p className="mt-2 text-meta text-muted-foreground">
              Revokes every session on the account at once, including this one,
              and it is the right action if you think someone else has your
              password.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-table text-muted-foreground">
            Notification preferences are not part of this build: no route stores
            them per account. What exists today is the client message thread and
            the delivery emails sent from a report — neither of which has a
            subscription setting to change here.
          </p>
        </CardContent>
      </Card>

      {/* Revoking one session: exact target, exact effect. */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke session"
        targetLabel="Session"
        target={revokeTarget ? describeUserAgent(revokeTarget.userAgent) : ''}
        confirmLabel="Revoke this session"
        effect={
          revokeTarget ? (
            <>
              That device is signed out immediately and cannot refresh. It will
              have to sign in again with the account&apos;s current password.
            </>
          ) : null
        }
        scope="This session only. Every other device, including this one, stays signed in."
        destructive
        onConfirm={async () => {
          if (!revokeTarget) return;
          await revokeSession(revokeTarget.id);
        }}
        onConfirmed={() => {
          setRevokeTarget(null);
          setNotice('That session was revoked.');
          void load();
        }}
      />

      {/* Sign out everywhere: server call first, then the local session. */}
      <ConfirmDialog
        open={signOutAllOpen}
        onOpenChange={setSignOutAllOpen}
        title="Sign out everywhere"
        targetLabel="Account"
        target={profile.email}
        confirmLabel="Sign out everywhere"
        destructive
        effect={
          <>
            Every session on this account is revoked on the server, including the
            one you are using now. Every device — this one too — will need to sign
            in again.
          </>
        }
        scope={
          <>
            {sessions.length} active session{sessions.length === 1 ? '' : 's'} will
            be revoked. Your password is not changed by this.
          </>
        }
        onConfirm={async () => {
          // The server call is the revocation. Clearing cookies on its own would
          // leave every other device signed in.
          await signOutEverywhere();
          await signOut();
        }}
        onConfirmed={() => router.push('/sign-in')}
      >
        <p className="text-meta text-muted-foreground">
          If you are doing this because you think the account is compromised,
          change the password afterwards as well — this ends the sessions, but the
          password itself stays as it was.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** Name, with the admin-only edit rule stated rather than discovered. */
function NameCard({
  userId,
  profile,
  isAdmin,
  onSaved,
}: {
  userId: string;
  profile: { name: string; role: string; email: string; createdAt: string };
  isAdmin: boolean;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => setName(profile.name), [profile.name]);

  const unchanged = name.trim() === profile.name.trim();
  const tooShort = name.trim().length > 0 && name.trim().length < 2;

  async function onSave() {
    if (!isAdmin || unchanged || tooShort || saving || !userId) return;
    setSaving(true);
    setError(null);
    try {
      await updateOwnName(userId, name.trim());
      await onSaved();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Name</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isAdmin ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="field-name">Display name</Label>
              <Input
                id="field-name"
                name="name"
                autoComplete="name"
                minLength={2}
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={saving}
                aria-invalid={tooShort ? true : undefined}
                aria-describedby="name-help"
              />
              <p id="name-help" className="text-meta text-muted-foreground">
                Shown against your work, decisions and messages. At least two
                characters.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => void onSave()}
                disabled={saving || unchanged || tooShort}
              >
                {saving ? 'Saving…' : 'Save name'}
              </Button>
              {unchanged ? (
                <span className="text-meta text-muted-foreground">No changes to save.</span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="text-table">
              We have you as <span className="font-medium">{profile.name || 'no name recorded'}</span>.
            </div>
            <Alert>
              <AlertCircle aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              <AlertDescription>
                Editing the name on an operator account is an administrator
                action — the only route that writes it is the admin-scoped people
                directory. Your own role is <span className="font-mono">{profile.role}</span>,
                so this field is read-only here. Ask an administrator to change it.
              </AlertDescription>
            </Alert>
          </>
        )}

        {error ? <ErrorState error={error} layout="inline" onRetry={() => setError(null)} /> : null}
      </CardContent>
    </Card>
  );
}

/** Password change, with the revocation consequence front and centre. */
function PasswordCard({ onChanged }: { onChanged: (sessionsRevoked: number) => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const tooShort = newPassword.length > 0 && newPassword.length < 10;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit =
    !submitting &&
    currentPassword.length > 0 &&
    newPassword.length >= 10 &&
    confirmPassword === newPassword;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await onChanged(result.sessionsRevoked);
    } catch (caught) {
      setError(toApiError(caught));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Password</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-table text-muted-foreground">
          Changing your password signs out every <em>other</em> device on this
          account. This session stays signed in — you will not be thrown back to
          the sign-in page.
        </p>

        {error ? (
          <ErrorState
            error={error}
            layout="inline"
            onRetry={() => setError(null)}
            fieldIdPrefix="field-"
            preserveNotice="Nothing was changed. Enter the passwords again to retry."
          />
        ) : null}

        <form onSubmit={onSubmit} noValidate className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="field-currentPassword">Current password</Label>
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
              aria-describedby="account-new-password-help"
            />
            <p id="account-new-password-help" className="text-meta text-muted-foreground">
              Required. At least ten characters.
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
              aria-describedby="account-confirm-help"
            />
            <p id="account-confirm-help" className="text-meta text-muted-foreground">
              Required.{' '}
              {mismatch ? (
                <span className="text-danger">The two passwords do not match.</span>
              ) : (
                'There is nothing to recover from here if it is mistyped — recovery is by emailed link.'
              )}
            </p>
          </div>

          <Button type="submit" disabled={!canSubmit}>
            {submitting ? 'Changing…' : 'Change password'}
          </Button>
        </form>

        <p className="mt-4 text-meta text-muted-foreground">
          Looking for the reset flow instead?{' '}
          <Link href="/recover" className="underline-offset-4 hover:text-foreground hover:underline">
            Recover access
          </Link>{' '}
          sends a single-use link to the address on your account, whether or not
          you still know the current password.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * A readable label for a session with no device label.
 *
 * The user-agent string is all the server records, so it is summarised rather
 * than shown raw — and when it cannot be summarised, "an unrecognised device"
 * is said plainly instead of being dressed up. An empty claim about which
 * device a session is would make the revoke decision harder, not easier.
 */
function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'An unrecognised device';
  const browser =
    /Firefox\//.test(userAgent) ? 'Firefox'
    : /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : null;
  const platform =
    /Macintosh|Mac OS X/.test(userAgent) ? 'macOS'
    : /Windows/.test(userAgent) ? 'Windows'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
    : /Linux/.test(userAgent) ? 'Linux'
    : null;

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return `An unrecognised browser on ${platform}`;
  return 'An unrecognised device';
}
