'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import type { ClientLoginCreatedDto } from '@/types/api';

export function CreateLoginPanel({
  onCreate,
}: {
  onCreate: (input: { email: string; name?: string }) => Promise<ClientLoginCreatedDto>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClientLoginCreatedDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await onCreate({ email, name: name || undefined });
      setResult(res);
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create login');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader
        title="Client portal login"
        action={!showForm && <Button variant="primary" onClick={() => setShowForm(true)}>+ Create login</Button>}
      />
      {showForm && (
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-caption text-faint">Client&apos;s email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-caption text-faint">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
            />
          </label>
          {error && <p className="text-body text-red">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create login'}
            </Button>
            <Button type="button" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {result && (
        <div className="rounded-r2 border border-accent-dim/40 bg-accent-dim/10 p-3 text-ui">
          <p className="mb-1">
            Login created for <strong>{result.email}</strong>.
          </p>
          <p className="mb-1">
            Temporary password: <code className="rounded bg-bg-inset px-1.5 py-0.5 font-mono">{result.temporaryPassword}</code>
          </p>
          <p className="text-caption text-faint">
            {result.emailSent
              ? 'Emailed to the client automatically.'
              : `Not emailed (${result.emailError ?? 'no reason given'}) — relay it by hand. Shown here once only.`}
          </p>
        </div>
      )}
      {!showForm && !result && <p className="text-body text-faint">No login created yet.</p>}
    </Panel>
  );
}
