'use client';

/**
 * Gates card — what is blocked / not wired right now, derived from
 * GET /api/integrations plus a short static list of features that need code,
 * not just a key. This is the live view of `docs/PRODUCTION-READINESS.md`.
 *
 * @module components/terminal/GatesCard
 */

import type { Integration } from '@/types/terminal';

export const gatesMeta = { key: 'gates' as const, title: 'Gates', icon: '⛒' };

/** Features that are gated by missing CODE, not just a missing env value. */
const NOT_WIRED: Array<{ name: string; detail: string; ref: string }> = [
  {
    name: 'Google Analytics / Search Console OAuth',
    detail: 'The Connect buttons report not-connected — the 3-legged OAuth flow + token storage is not built. GSC data is imported via a pasted CSV in sleeper-refresh.',
    ref: 'PRODUCTION-READINESS.md §3.1',
  },
  {
    name: 'Redis-backed rate-limit store',
    detail: 'Throttler uses an in-memory store — fine for one backend instance, wrong for several.',
    ref: 'PRODUCTION-READINESS.md §5.7',
  },
  {
    name: 'Deployment artifacts',
    detail: 'No Dockerfiles, no CI. SQLite still the datasource (needs Postgres for prod).',
    ref: 'PRODUCTION-READINESS.md §4, §6',
  },
];

/** Dev-only escape hatches that must be OFF in production. */
const DEV_FLAGS = ['MEASUREMENT_ALLOW_MOCK', 'INTERNAL_LINK_ALLOW_FIXTURE', 'SERP_ALLOW_FIXTURE'];

export function GatesCard({ integrations }: { integrations: Integration[] }) {
  const blocked = integrations.filter((i) => i.category !== 'mode' && !i.connected);
  const swarmLive = integrations.find((i) => i.key === 'swarm-live');

  return (
    <div className="p-3 text-[12px]">
      <p className="mb-2 text-faint">
        Live view of what still needs configuring — see{' '}
        <code className="rounded bg-bg-inset px-1 text-dim">docs/PRODUCTION-READINESS.md</code>.
      </p>

      {/* needs a key / credential */}
      <Section title={`Needs a key or credential (${blocked.length})`}>
        {blocked.length === 0 ? (
          <p className="text-accent">All configurable integrations are connected.</p>
        ) : (
          <ul className="space-y-1.5">
            {blocked.map((i) => (
              <li key={i.key} className="rounded border border-border/60 bg-bg-inset px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
                  <span className="text-dim">{i.name}</span>
                  <code className="ml-auto rounded bg-bg-raised px-1 text-[10px] text-faint">{i.configHint}</code>
                </div>
                <p className="mt-0.5 text-[11px] text-faint">{i.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* needs code */}
      <Section title={`Not wired — needs code (${NOT_WIRED.length})`}>
        <ul className="space-y-1.5">
          {NOT_WIRED.map((n) => (
            <li key={n.name} className="rounded border border-border/60 bg-bg-inset px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red" />
                <span className="text-dim">{n.name}</span>
                <span className="ml-auto text-[10px] text-faint">{n.ref}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-faint">{n.detail}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* modes */}
      <Section title="Modes">
        <ul className="space-y-1">
          <li className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${swarmLive?.connected ? 'bg-accent' : 'bg-faint'}`} />
            <span className="text-dim">Swarm live spend</span>
            <span className="ml-auto text-[10px] text-faint">
              {swarmLive?.connected ? 'ON — real AI/SERP spend allowed' : 'OFF — deterministic adapters only'}
            </span>
          </li>
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber" />
            <span className="text-dim">Dev flags to disable in prod</span>
            <span className="ml-auto text-[10px] text-faint">{DEV_FLAGS.join(', ')}</span>
          </li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-faint">{title}</h3>
      {children}
    </div>
  );
}
