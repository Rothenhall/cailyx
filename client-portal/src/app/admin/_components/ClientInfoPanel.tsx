'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { useToast } from '@/components/ui/Toast';
import type { ClientDetailDto } from '@/types/api';

export function ClientInfoPanel({
  client,
  onUpdate,
}: {
  client: ClientDetailDto;
  onUpdate: (patch: Partial<{ name: string; contactName: string; contactEmail: string; status: string; notes: string }>) => Promise<void>;
}) {
  const { push } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(client.name);
  const [contactName, setContactName] = useState(client.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(client.contactEmail ?? '');
  const [status, setStatus] = useState<string>(client.status);
  const [notes, setNotes] = useState(client.notes ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await onUpdate({ name, contactName, contactEmail, status, notes });
      push('Client updated');
      setEditing(false);
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to update client', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <Panel>
        <PanelHeader title={client.name} action={<Button onClick={() => setEditing(true)}>Edit</Button>} />
        <dl className="grid grid-cols-2 gap-3 text-ui">
          <div>
            <dt className="text-caption text-faint">Contact</dt>
            <dd>{client.contactName || '—'}</dd>
          </div>
          <div>
            <dt className="text-caption text-faint">Email</dt>
            <dd>{client.contactEmail || '—'}</dd>
          </div>
          <div>
            <dt className="text-caption text-faint">Status</dt>
            <dd className="capitalize">{client.status}</dd>
          </div>
          <div>
            <dt className="text-caption text-faint">Notes</dt>
            <dd className="whitespace-pre-wrap">{client.notes || '—'}</dd>
          </div>
        </dl>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader title="Edit client" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-caption text-faint">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong" />
        </label>
        <label className="block">
          <span className="mb-1 block text-caption text-faint">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong">
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="churned">churned</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-caption text-faint">Contact name</span>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong" />
        </label>
        <label className="block">
          <span className="mb-1 block text-caption text-faint">Contact email</span>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-caption text-faint">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong" />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </Panel>
  );
}
