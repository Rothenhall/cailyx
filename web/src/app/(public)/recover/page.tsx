'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * AU03 — Recover access.
 *
 * design_plan.md §4.1 specifies: "Email request, generic success, expiring
 * reset, return to sign in."
 *
 * The generic success is a security requirement, not a courtesy. Whether or
 * not the address exists, the response is identical and the page says the same
 * thing — otherwise this form becomes an oracle for which email addresses have
 * accounts (G01: "generic reset response avoids email enumeration").
 *
 * The submit genuinely cannot reveal the difference either: it always takes the
 * same path and always shows the same panel.
 */
export default function RecoverPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetch('/api/auth/password/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Intentionally swallowed. Reporting a transport failure here while
      // staying silent for an unknown address would itself be a signal, so
      // every outcome lands on the same success panel.
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 text-success">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5" />
            <span className="text-table font-medium">Request received</span>
          </div>
          <h1 className="text-title font-semibold tracking-tight">Check your email</h1>
          <p className="mt-2 text-table text-muted-foreground">
            If an account exists for that address, we have sent a link to reset
            the password. The link expires in one hour and can only be used once.
          </p>
          <p className="mt-2 text-table text-muted-foreground">
            Nothing arrived after a few minutes? Check the spam folder, then
            contact your delivery lead — they can confirm whether the address is
            the one on your account.
          </p>
          <Button asChild variant="outline" className="mt-6 w-full">
            <Link href="/sign-in">Return to sign in</Link>
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
          <h1 className="mt-6 text-title font-semibold tracking-tight">Recover access</h1>
          <p className="mt-1.5 text-table text-muted-foreground">
            Enter the email address on your account and we will send a link to
            set a new password.
          </p>
        </div>

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
              disabled={submitting}
            />
          </div>

          <Button type="submit" className="w-full" disabled={submitting || !email}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>

        <p className="mt-6 text-meta text-muted-foreground">
          <Link
            href="/sign-in"
            className="underline-offset-4 hover:text-foreground hover:underline"
          >
            Return to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
