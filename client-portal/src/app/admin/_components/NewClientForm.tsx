'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { useToast } from '@/components/ui/Toast';

export function NewClientForm({
  onCreate,
  onClose,
}: {
  onCreate: (input: { name: string; contactName?: string; contactEmail?: string; notes?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const { push } = useToast();
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onCreate({
        name,
        contactName: contactName || undefined,
        contactEmail: contactEmail || undefined,
      });
      push(`Client "${name}" created`);
      onClose();
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to create client', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="mb-4">
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-caption text-faint">Client name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-caption text-faint">Contact name</span>
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-caption text-faint">Contact email</span>
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
          />
        </label>
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create client'}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}
