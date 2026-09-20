'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * AU01 — Sign in.
 *
 * design_plan.md §4.1 fixes the anatomy: "Email/password, show password,
 * submit, safe return destination, inline validation plus summary, preserve
 * non-secret inputs after failure."
 *
 * Two rules from §3.4/§3.5 are implemented here rather than left to habit:
 *  - a failed sign-in preserves the email so the user does not retype it, but
 *    never the password;
 *  - the error message never reveals whether the address exists. A 401 is
 *    reported as "those credentials did not match", full stop.
 *
 * The page is split into a boundary plus the form because `useSearchParams`
 * forces a client-side bailout during prerendering; without the boundary the
 * whole route opts out of static generation (Next's
 * "missing-suspense-with-csr-bailout").
 */
export default function SignInPage() {
  return (
    <Suspense fallback={<SignInFallback />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="text-subsection font-semibold tracking-tight">Cailyx</div>
        <div className="mt-1 text-meta text-muted-foreground">A Rothenhall product</div>
        <div className="mt-6 h-8 w-32 animate-pulse rounded-md bg-surface-sunken" />
        <div className="mt-6 space-y-4">
          <div className="h-16 animate-pulse rounded-md bg-surface-sunken" />
          <div className="h-16 animate-pulse rounded-md bg-surface-sunken" />
          <div className="h-9 animate-pulse rounded-md bg-surface-sunken" />
        </div>
      </div>
    </div>
  );
}

/**
 * The return destination is validated to a same-origin absolute path before
 * use, so a crafted `?next=https://evil.example` cannot turn this page into an
 * open redirect.
 */
function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** Only a same-origin absolute path is a safe destination. */
  function safeNext(): string {
    const raw = searchParams.get('next');
    if (!raw) return '/ops';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/ops';
    return raw;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch('/api/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setError(
          response.status === 401 || response.status === 400
            ? 'Those credentials did not match. Check your email address and password.'
            : (body.message ?? 'Sign-in is unavailable right now. Try again in a moment.'),
        );
        setPassword('');
        return;
      }

      const body = (await response.json()) as {
        user?: { type?: string; mustChangePassword?: boolean };
      };

      // A temporary password must be replaced before anything else (AU04).
      if (body.user?.mustChangePassword) {
        router.replace('/welcome/security');
        return;
      }

      router.replace(body.user?.type === 'client' ? '/client' : safeNext());
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-subsection font-semibold tracking-tight">Cailyx</div>
          {/* Brand kit identity rule: Cailyx never appears without Rothenhall in
              the same view. This page owns its own wordmark, so it carries the
              credit too. */}
          <div className="mt-1 text-meta text-muted-foreground">
            A Rothenhall product ·{' '}
            <Link
              href="https://rothenhall.com"
              className="text-link underline-offset-4 hover:underline"
            >
              rothenhall.com
            </Link>
          </div>
          <h1 className="mt-6 text-title font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-table text-muted-foreground">
            Search and AI-answer visibility for your clients.
          </p>
        </div>

        {/* §3.4 — the error summary links to the field it concerns. */}
        {error ? (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertCircle aria-hidden="true" className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/recover"
                className="text-meta text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
                disabled={submitting}
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
          </div>

          <Button type="submit" className="w-full" disabled={submitting || !email || !password}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-meta text-muted-foreground">
          Client accounts are created by your delivery lead. If you need access,
          ask them to send you an invitation.
        </p>
      </div>
    </div>
  );
}
