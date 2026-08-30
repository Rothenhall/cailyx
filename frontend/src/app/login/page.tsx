'use client';

/**
 * Login — dark terminal styling. First account bootstraps to admin (backend
 * `auth.register`); afterwards it logs in.
 *
 * @module app/login/page
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch, setSession } from '@/lib/api';
import type { AuthResponse } from '@/types/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login' ? { email, password } : { email, password, name };
      const res = await apiFetch<AuthResponse>(path, { method: 'POST', json: body });
      setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 text-sm">
          <span className="text-accent">▚</span>
          <span className="font-semibold tracking-wide">CAILYX</span>
        </div>

        <div className="rounded-lg border border-border bg-bg-raised p-5">
          <div className="mb-4 flex gap-4 text-xs">
            <button
              onClick={() => setMode('login')}
              className={mode === 'login' ? 'text-accent' : 'text-faint hover:text-dim'}
            >
              log in
            </button>
            <button
              onClick={() => setMode('register')}
              className={mode === 'register' ? 'text-accent' : 'text-faint hover:text-dim'}
            >
              register (first user = admin)
            </button>
          </div>

          <form onSubmit={submit} className="space-y-3">
            {mode === 'register' && (
              <Field label="name" value={name} onChange={setName} required minLength={2} />
            )}
            <Field label="email" type="email" value={email} onChange={setEmail} required />
            <Field
              label="password"
              type="password"
              value={password}
              onChange={setPassword}
              required
              minLength={10}
            />
            {error && <p className="text-xs text-red">{error}</p>}
            <button
              disabled={busy}
              className="w-full rounded-md border border-accent-dim bg-accent-dim/20 px-3 py-2 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-50"
            >
              {busy ? '…' : mode === 'login' ? 'log in →' : 'create account →'}
            </button>
          </form>
        </div>
        <p className="mt-3 text-center text-xs text-faint">
          password min 10 chars · token stored in this browser only
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-faint">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        minLength={minLength}
        className="w-full rounded-md border border-border bg-bg-inset px-3 py-2 text-sm outline-none focus:border-border-strong"
      />
    </label>
  );
}
