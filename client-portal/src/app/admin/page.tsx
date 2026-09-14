'use client';

import { useState } from 'react';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { useClientsList } from './_lib/useClientsList';
import { TopBar } from '@/components/ui/TopBar';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { NewClientForm } from './_components/NewClientForm';
import { ClientRow } from './_components/ClientRow';

export default function AdminClientsPage() {
  const user = useRequireAuth('operator');
  const { clients, error, createClient } = useClientsList();
  const [showNew, setShowNew] = useState(false);

  const stats = clients && {
    total: clients.length,
    projects: clients.reduce((n, c) => n + c.projectCount, 0),
    gaps: clients.reduce((n, c) => n + c.openGapCount, 0),
    onboarding: clients.filter((c) => c.hasProjectOnboarding).length,
  };

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="admin" />
      <main className="mx-auto max-w-4xl space-y-4 px-5 py-6">
        {stats && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Clients', value: stats.total },
              { label: 'Projects', value: stats.projects },
              { label: 'Open gaps', value: stats.gaps },
              { label: 'Onboarding now', value: stats.onboarding },
            ].map((s) => (
              <div key={s.label} className="rounded-r3 border border-border bg-bg-raised p-3.5">
                <div className="text-caption uppercase tracking-wide text-faint">{s.label}</div>
                <div className="mt-1 text-title font-semibold">{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {showNew && <NewClientForm onCreate={createClient} onClose={() => setShowNew(false)} />}

        <Panel>
          <PanelHeader
            title="Clients"
            action={!showNew && <Button variant="primary" onClick={() => setShowNew(true)}>+ New client</Button>}
          />
          {error && <p className="mb-3 text-body text-red">{error}</p>}
          {clients === null && !error && (
            <div className="space-y-2">
              <div className="h-12 skeleton" />
              <div className="h-12 skeleton" />
            </div>
          )}
          {clients !== null && clients.length === 0 && (
            <p className="py-6 text-center text-body text-faint">No clients yet — create one above.</p>
          )}
          {clients !== null && clients.length > 0 && (
            <div className="-mx-4">
              {clients.map((c) => (
                <ClientRow key={c.id} client={c} />
              ))}
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
