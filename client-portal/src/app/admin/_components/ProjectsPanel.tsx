'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { BandBadge, OnboardingBadge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import type { ClientProjectSummaryDto } from '@/types/api';

export function ProjectsPanel({
  clientId,
  projects,
  onAdd,
}: {
  clientId: string;
  projects: ClientProjectSummaryDto[];
  onAdd: (input: { name: string; domain: string }) => Promise<void>;
}) {
  const { push } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onAdd({ name, domain });
      push(`Project "${name}" added — Day-1 pipeline running`);
      setShowAdd(false);
      setName('');
      setDomain('');
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to add project', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader
        title="Projects"
        action={!showAdd && <Button variant="primary" onClick={() => setShowAdd(true)}>+ Add project</Button>}
      />
      {showAdd && (
        <form onSubmit={submit} className="mb-4 grid grid-cols-1 gap-3 rounded-r2 border border-border bg-bg-inset p-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-caption text-faint">Project name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-r2 border border-border bg-bg-raised px-3 py-2 text-ui outline-none focus:border-border-strong"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-caption text-faint">Domain</span>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              required
              className="w-full rounded-r2 border border-border bg-bg-raised px-3 py-2 text-ui outline-none focus:border-border-strong"
            />
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Starting…' : 'Run Day-1 pipeline'}
            </Button>
            <Button type="button" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {projects.length === 0 && !showAdd && (
        <p className="py-4 text-center text-body text-faint">No projects yet.</p>
      )}
      <div className="space-y-2">
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/admin/clients/${clientId}/projects/${p.id}`}
            className="flex items-center justify-between gap-3 rounded-r2 border border-border px-3 py-2 transition-colors hover:border-border-strong hover:bg-bg-inset"
          >
            <div className="min-w-0">
              <div className="truncate text-ui font-medium">{p.name}</div>
              <div className="truncate text-caption text-faint">{p.domain}</div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <OnboardingBadge status={p.onboardingStatus} />
              {p.onboardingStep && p.onboardingStatus === 'running' && (
                <span className="text-caption text-faint">{p.onboardingStep}</span>
              )}
              {p.onboardingStatus === 'failed' && p.onboardingError && (
                <span className="max-w-[16rem] truncate text-caption text-red" title={p.onboardingError}>
                  {p.onboardingError}
                </span>
              )}
              {p.openGapCount > 0 && (
                <span className="rounded-r2 bg-cognac-soft/20 px-1.5 py-0.5 text-caption text-cognac">
                  {p.openGapCount} gap{p.openGapCount === 1 ? '' : 's'}
                </span>
              )}
              <BandBadge band={p.latestBand} />
              <span className="text-caption text-faint">View status →</span>
            </div>
          </Link>
        ))}
      </div>
    </Panel>
  );
}
