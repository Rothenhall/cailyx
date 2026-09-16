'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';

/**
 * AU06 — Bootstrap administration.
 *
 * design_plan.md §4.1: *"First admin credentials for controlled initial
 * installation; **no public operator signup after setup**."* And §5.1 step 6:
 * *"First admin provisioning uses AU06 and `register`. After any user exists,
 * registration requires an admin bearer token. It is not a public SaaS signup
 * path."*
 *
 * That "not a signup path" framing is what shapes this screen. It is not a
 * register form that happens to be first; it is a one-time installation step
 * that **becomes inert the moment it is used**. So the screen asks the server
 * whether it is still needed, and if it is not, it says so plainly and offers
 * no form at all — it does not render fields that would fail on submit.
 *
 * The check is deliberately re-run at submit time rather than trusted from
 * load: two people can open the screen at once, and the second must get a clear
 * "someone else completed setup" rather than a puzzling 403.
 */
export default function SetupPage() {
  const router = useRouter();

  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const checkState = useCallback(async () => {
    try {
      setLoadError(null);
      const state = await api.get<{ needsSetup: boolean }>('/auth/bootstrap-state');
      setNeedsSetup(state.needsSetup);
    } catch (caught) {
      setLoadError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server to check whether setup is needed.',
      );
    }
  }, []);

  useEffect(() => {
    void checkState();
  }, [checkState]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    if (password.length < 10) {
      setError('The password must be at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      // No `role` is sent. The first account becomes admin server-side, and
      // naming a role here would imply the caller chooses — they do not.
      await api.post('/auth/register', { name: name.trim(), email: email.trim(), password });

      // The account exists now. If this fails, the operator still has a valid
      // login, so the failure must not read as "setup failed".
      router.replace('/sign-in?setup=complete');
    } catch (caught) {
      if (caught instanceof ApiError && caught.kind === 'conflict') {
        setError(
          'That email address is already registered. If this installation is already set up, sign in instead.',
        );
      } else if (caught instanceof ApiError && caught.kind === 'forbidden') {
        // The exact race this screen guards against.
        setNeedsSetup(false);
        setError(null);
      } else {
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'The administrator account could not be created. Nothing was saved.',
        );
      }
      setPassword('');
      setConfirm('');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-md">
          <Alert variant="destructive" role="alert">
            <AlertCircle aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Could not check this installation</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{loadError}</p>
              <Button variant="outline" size="sm" onClick={() => void checkState()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  if (needsSetup === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-md space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  /**
   * Already set up. No form is rendered — see the page note. Offering one would
   * produce a 403 on submit for anyone who is not an admin, which reads as a
   * bug rather than as the intended closed door.
   */
  if (!needsSetup) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-2 text-muted-foreground">
            <ShieldAlert aria-hidden="true" className="h-5 w-5" />
            <span className="text-table font-medium">Setup is already complete</span>
          </div>
          <h1 className="text-title font-semibold tracking-tight">
            This installation has an administrator
          </h1>
          <p className="mt-2 text-table text-muted-foreground">
            The first-administrator step can only run once. Adding more people is
            an administrative action taken from inside the app, not from this
            page.
          </p>
          <p className="mt-2 text-table text-muted-foreground">
            If you are trying to set up a <em>new</em> installation, point this
            app at an empty database — this one already has accounts.
          </p>
          <Button asChild className="mt-6 w-full">
            <Link href="/sign-in">Go to sign in</Link>
          </Button>
          <p className="mt-6 text-meta text-muted-foreground">
            This page is public by necessity — it has to run before any account
            exists. It reports only whether an administrator exists, and nothing
            about who they are.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8">
          <div className="text-subsection font-semibold tracking-tight">Cailyx</div>
          <h1 className="mt-6 text-title font-semibold tracking-tight">
            Create the first administrator
          </h1>
          <p className="mt-1.5 text-table text-muted-foreground">
            This runs once. The account you create here becomes the installation
            administrator and can add everyone else.
          </p>
        </div>

        <Alert className="mb-4">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>No accounts exist yet</AlertTitle>
          <AlertDescription>
            Once you create this one, this page stops offering a form. It is not a
            public signup route.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertCircle aria-hidden="true" className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Administrator</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Your name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                  autoFocus
                  disabled={submitting}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  required
                  disabled={submitting}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">
                  Password
                  {/* §3.4 — the constraint is stated in text, not by colour. */}
                  <span className="ml-1 text-meta font-normal text-muted-foreground">
                    (at least 10 characters, required)
                  </span>
                </Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={10}
                  disabled={submitting}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  required
                  disabled={submitting}
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={submitting || !name.trim() || !email.trim() || !password}
              >
                {submitting ? 'Creating…' : 'Create administrator'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
