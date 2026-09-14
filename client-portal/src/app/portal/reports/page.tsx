'use client';

import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { usePortal } from '../_lib/usePortal';
import { TopBar } from '@/components/ui/TopBar';
import { Panel } from '@/components/ui/Panel';
import { BandBadge } from '@/components/ui/Badge';

export default function PortalReportsPage() {
  const user = useRequireAuth('client');
  const { reports, error } = usePortal();

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="portal" />
      <main className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        <Link href="/portal" className="text-caption text-faint hover:text-dim">
          ← Projects
        </Link>
        <h1 className="text-title font-medium">Reports</h1>

        {error && <p className="text-body text-red">{error}</p>}
        {!reports && !error && <div className="h-32 skeleton" />}
        {reports && reports.length === 0 && (
          <p className="py-8 text-center text-body text-faint">No reports yet.</p>
        )}

        <div className="space-y-2">
          {reports?.map((r) => (
            <Link key={r.id} href={`/portal/reports/${r.slug}`}>
              <Panel className="transition-colors hover:border-border-strong">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-ui font-medium">{r.title}</div>
                    <div className="text-caption text-faint">{new Date(r.createdAt).toLocaleDateString()}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-title font-semibold">{r.scoreTotal}</span>
                    <BandBadge band={r.scoreBand} />
                  </div>
                </div>
              </Panel>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
