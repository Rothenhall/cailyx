'use client';

import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { usePortal } from './_lib/usePortal';
import { TopBar } from '@/components/ui/TopBar';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { BandBadge, OnboardingBadge } from '@/components/ui/Badge';

export default function PortalHomePage() {
  const user = useRequireAuth('client');
  const { projects, error } = usePortal();

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="portal" />
      <main className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        <div className="flex items-center justify-between">
          <h1 className="text-title font-medium">Your projects</h1>
          <nav className="flex gap-4 text-caption">
            <Link href="/portal/reports" className="text-faint hover:text-dim">
              Reports
            </Link>
            <Link href="/portal/messages" className="text-faint hover:text-dim">
              Messages
            </Link>
          </nav>
        </div>

        {error && <p className="text-body text-red">{error}</p>}
        {!projects && !error && <div className="h-32 skeleton" />}
        {projects && projects.length === 0 && (
          <p className="py-8 text-center text-body text-faint">No projects yet — check back soon.</p>
        )}

        <div className="space-y-2">
          {projects?.map((p) => (
            <Link key={p.id} href={`/portal/projects/${p.id}`}>
              <Panel className="transition-colors hover:border-border-strong">
                <PanelHeader title={p.name} action={<BandBadge band={p.latestBand} />} />
                <div className="flex items-center justify-between text-ui">
                  <span className="text-faint">{p.domain}</span>
                  <div className="flex items-center gap-3">
                    <OnboardingBadge status={p.onboardingStatus} />
                    {p.onboardingStatus === 'running' && p.onboardingStep && (
                      <span className="text-caption text-faint">{p.onboardingStep}</span>
                    )}
                    {p.latestScore !== null && <span className="text-caption text-dim">Score {p.latestScore}</span>}
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
