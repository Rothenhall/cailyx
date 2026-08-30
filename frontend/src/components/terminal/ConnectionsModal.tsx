'use client';

/**
 * Connections panel — every external service Cailyx can use, grouped by
 * category, with its live connected/enabled status and the env var(s) or OAuth
 * flow that provides it. Data from `GET /api/integrations`.
 *
 * @module components/terminal/ConnectionsModal
 */

import type { Integration, IntegrationCategory } from '@/types/terminal';

const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  analytics: 'Analytics (Google)',
  'ai-surface': 'AI answer surfaces',
  serp: 'SERP data',
  performance: 'Performance',
  infrastructure: 'Infrastructure',
  monetization: 'Monetization',
  email: 'Email',
  mode: 'Modes',
};

const ORDER: IntegrationCategory[] = [
  'analytics',
  'ai-surface',
  'serp',
  'performance',
  'infrastructure',
  'monetization',
  'email',
  'mode',
];

export function ConnectionsModal({
  integrations,
  summary,
  onClose,
}: {
  integrations: Integration[];
  summary: { total: number; connected: number } | null;
  onClose: () => void;
}) {
  const byCat = ORDER.map((cat) => ({
    cat,
    items: integrations.filter((i) => i.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#1a1712]/45 p-6" onClick={onClose}>
      <div
        className="mt-8 w-full max-w-2xl rounded-lg border border-border bg-bg-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-widest text-dim">Connections</h2>
            {summary && (
              <p className="text-[11px] text-faint">
                {summary.connected} of {summary.total} connected
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-faint hover:text-dim">
            ✕
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {byCat.map((g) => (
            <div key={g.cat} className="mb-4 last:mb-0">
              <h3 className="mb-2 text-[11px] uppercase tracking-widest text-faint">{CATEGORY_LABEL[g.cat]}</h3>
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <li key={i.key} className="rounded-md border border-border bg-bg-inset p-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          i.status === 'connected' || i.status === 'enabled' ? 'bg-accent' : 'bg-faint'
                        }`}
                      />
                      <span className="text-[13px] font-semibold text-dim">{i.name}</span>
                      <span
                        className={`ml-auto rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                          i.status === 'connected' || i.status === 'enabled'
                            ? 'border-accent-dim text-accent'
                            : 'border-border text-faint'
                        }`}
                      >
                        {i.status}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[12px] text-faint">{i.detail}</p>
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-faint">
                      <code className="rounded bg-bg-raised px-1.5 py-0.5 text-dim">{i.configHint}</code>
                      {i.connectUrl && (
                        <a href={i.connectUrl} className="text-blue underline">
                          connect
                        </a>
                      )}
                      {i.docsPath && <span className="truncate">· {i.docsPath}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <footer className="border-t border-border px-4 py-2 text-[11px] text-faint">
          Set values in <code className="text-dim">backend/.env</code> and restart. OAuth flows for Google
          Analytics / Search Console are an external prerequisite and are not wired yet.
        </footer>
      </div>
    </div>
  );
}
