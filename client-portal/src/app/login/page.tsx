'use client';

/**
 * Login — the one entry point for both operators and clients. After a
 * successful login, `user.type` decides where to land:
 *   operator -> /admin      client -> /portal
 * No self-registration here — operator accounts already exist (created via
 * the main frontend/ app); client accounts are provisioned by an operator
 * (POST /clients/:id/login), never self-signed-up.
 *
 * @module app/login/page
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { login } from '@/lib/endpoints';
import { setSession } from '@/lib/api';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(email, password);
      setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken, user: res.user });
      router.push(res.user.type === 'client' ? '/portal' : '/admin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 text-sm">
          <span className="text-cognac">▚</span>
          <span className="font-semibold tracking-wide">CAILYX</span>
          <span className="text-faint">· client portal</span>
        </div>

        <div className="rounded-r3 border border-border bg-bg-raised p-5 shadow-e1">
          <form onSubmit={submit} className="space-y-3">
            <Field label="email" type="email" value={email} onChange={setEmail} required />
            <Field label="password" type="password" value={password} onChange={setPassword} required />
            {error && <p className="text-body text-red">{error}</p>}
            <button
              disabled={busy}
              className="w-full rounded-r2 border border-accent-dim bg-accent-dim/20 px-3 py-2 text-ui text-accent transition-colors hover:bg-accent-dim/30 disabled:opacity-50"
            >
              {busy ? '…' : 'log in →'}
            </button>
          </form>
        </div>
        <p className="mt-3 text-center text-caption text-faint">
          operators: same account as the main console · clients: use the login your operator sent you
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-caption text-faint">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
      />
    </label>
  );
}
