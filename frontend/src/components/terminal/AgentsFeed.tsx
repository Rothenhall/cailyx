'use client';

/**
 * Agents Feed pane — one card per capability, live status from
 * `GET /projects/:id/agents`. Cards expand to show what the agent is doing.
 *
 * @module components/terminal/AgentsFeed
 */

import { useState } from 'react';
import type { AgentCard, AgentsResponse, AgentStatus } from '@/types/terminal';

export const agentsMeta = { key: 'agents' as const, title: 'Agents Feed', icon: '●' };

const DOT: Record<AgentStatus, string> = {
  ready: 'bg-accent',
  attention: 'bg-amber',
  running: 'bg-blue',
  blocked: 'bg-red',
  idle: 'bg-faint',
};

const GLYPH: Record<string, string> = {
  seo: '⌁',
  geo: '◎',
  content: '✎',
  authority: '☆',
  journeys: '⋔',
  personas: '⍜',
  council: '⚖',
  mentions: '✦',
  serp: '⌸',
  monitoring: '♺',
};

function glyph(key: string): string {
  return GLYPH[key] ?? '▪';
}

export function AgentsFeed({
  data,
  loading,
}: {
  data: AgentsResponse | null;
  loading: boolean;
}) {
  return (
    <>
      {loading && !data ? (
        <p className="p-3 text-faint">loading agents…</p>
      ) : !data ? (
        <p className="p-3 text-faint">select a project</p>
      ) : (
        <div>
          <div className="flex gap-3 border-b border-border px-3 py-2 text-[11px] text-faint">
            <span><span className="text-accent">{data.summary.ready}</span> ready</span>
            <span><span className="text-amber">{data.summary.needAttention}</span> attention</span>
            <span><span className="text-faint">{data.summary.idle}</span> idle</span>
          </div>
          <ul>
            {data.agents.map((a) => (
              <AgentRow key={a.key} a={a} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function AgentRow({ a }: { a: AgentCard }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-border/60">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-bg-inset">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-bg-inset text-dim">
          {glyph(a.key)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-dim">{a.name}</span>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[a.status]}`} />
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-faint">{a.headline}</span>
        </span>
        <span className="mt-1 text-faint">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-border/60 bg-bg-inset px-3 py-2.5 text-[12px]">
          {a.metric && <p className="mb-1 text-faint">{a.metric}</p>}
          <ul className="space-y-1">
            {a.activity.map((line, i) => (
              <li key={i} className="text-dim">
                <span className="text-accent-dim">└ </span>
                {line}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-faint">
            <span className="rounded border border-border px-1.5 py-0.5 text-dim">{a.cta}</span>
            {a.lastActivityAt && <span>last: {new Date(a.lastActivityAt).toLocaleString()}</span>}
          </div>
        </div>
      )}
    </li>
  );
}
