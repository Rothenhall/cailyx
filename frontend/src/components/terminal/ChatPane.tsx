'use client';

/**
 * Chat card body — a terminal assistant that answers questions about the
 * project from data the dashboard already has (agents feed, connections,
 * context). Deterministic command router; no LLM required. Rendered inside a
 * <CanvasCard> which provides the frame.
 *
 * @module components/terminal/ChatPane
 */

import { useEffect, useRef, useState } from 'react';
import type { AgentsResponse, Integration, ProjectDetail } from '@/types/terminal';

export const chatMeta = { key: 'chat' as const, title: 'Chat', icon: '◧' };

interface Msg {
  role: 'you' | 'cailyx';
  text: string;
}

const HELP = [
  'commands:',
  '  status / agents      — what every agent is doing',
  '  issues               — top on-page problems',
  '  visibility / geo      — AI mention & citation rates',
  '  connections           — integration status',
  '  gates                 — what still needs configuring',
  '  attention             — only what needs you',
  '  context               — the company profile',
  '  help                  — this list',
].join('\n');

export function ChatPane({
  project,
  agents,
  integrations,
  onOpenConnections,
  seed,
  onSeedConsumed,
}: {
  project: ProjectDetail | null;
  agents: AgentsResponse | null;
  integrations: Integration[];
  onOpenConnections: () => void;
  /** a query dropped in from another card (e.g. the Flywheel) */
  seed?: string | null;
  onSeedConsumed?: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMsgs([
      {
        role: 'cailyx',
        text: project
          ? `Ready. Ask me anything about ${project.domain}, or type \`help\`.`
          : 'Create or select a project to begin.',
      },
    ]);
  }, [project?.id, project?.domain]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs]);

  const send = (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setMsgs((m) => [...m, { role: 'you', text: q }]);
    setInput('');
    const answer = respond(q.toLowerCase(), { project, agents, integrations });
    if (answer === '__CONNECTIONS__') {
      onOpenConnections();
      setMsgs((m) => [...m, { role: 'cailyx', text: 'Opened the connections panel.' }]);
      return;
    }
    setMsgs((m) => [...m, { role: 'cailyx', text: answer }]);
  };

  // a query dropped in from the Flywheel
  useEffect(() => {
    if (!seed) return;
    setMsgs((m) => [
      ...m,
      { role: 'you', text: seed },
      {
        role: 'cailyx',
        text:
          `Suggested buyer query: "${seed}".\n` +
          'Add it to a query set, or plan a journey from it — the Journey Agent will branch it into a full search path.',
      },
    ]);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  return (
    <div className="flex h-full flex-col">
      {/* CMO banner */}
      <div className="flex items-center gap-2 border-b border-night-line bg-night-2 px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-night-line text-dim">▚</span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[12px] font-semibold text-dim">Hire your full-time CMO</div>
          <div className="truncate text-[10px] text-faint">AI-powered marketing — fixed-fee sprints &amp; monthly retainers</div>
        </div>
        <button
          onClick={() =>
            setMsgs((m) => [
              ...m,
              {
                role: 'cailyx',
                text:
                  'Engagements: fixed-fee sprint · monthly operating retainer · portfolio-wide retainer.\n' +
                  'Checkout links are issued through the delivery module once STRIPE_CHECKOUT_URL_* is set — see `connections`.',
              },
            ])
          }
          className="shrink-0 rounded border border-accent-dim bg-accent-dim/20 px-2 py-1 text-[11px] text-accent"
        >
          Hire
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[12px]">
        {msgs.map((m, i) => (
          <div key={i}>
            <div className={m.role === 'you' ? 'text-blue' : 'text-accent'}>{m.role === 'you' ? '> you' : '· cailyx'}</div>
            <pre className="mt-0.5 whitespace-pre-wrap font-mono text-dim">{m.text}</pre>
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="shrink-0 border-t border-night-line p-2"
      >
        <div className="flex items-center gap-2 rounded-md border border-night-line bg-night-2 px-2">
          <span className="text-faint">$</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="ask me anything…  (try: status)"
            className="flex-1 bg-transparent py-2 text-[12px] text-night-text outline-none"
          />
          <button type="submit" className="text-faint hover:text-accent" aria-label="send">
            ↩
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── deterministic responder ────────────────────────────────── */
function respond(
  q: string,
  ctx: { project: ProjectDetail | null; agents: AgentsResponse | null; integrations: Integration[] },
): string {
  const { project, agents, integrations } = ctx;
  if (!project) return 'No project selected.';

  if (q === 'help' || q === '?') return HELP;
  if (q.includes('connection') || q.includes('integration')) return '__CONNECTIONS__';

  if (q === 'gates' || q.includes('blocked') || q.includes('pending')) {
    const blocked = integrations.filter((i) => i.category !== 'mode' && !i.connected);
    return blocked.length === 0
      ? 'No integration gates open. Code-level gaps: GA/GSC OAuth, deployment artifacts — see the Gates card.'
      : 'Needs a key: ' + blocked.map((i) => `${i.name} (${i.configHint})`).join('; ') + '. See the Gates card for the full list.';
  }

  if (q === 'context' || q.includes('profile') || q.includes('company')) {
    return [
      `${project.name} — ${project.domain}`,
      project.category ? `category: ${project.category}` : null,
      project.notes ? `\n${project.notes}` : '(no description yet — add one in the Context card)',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (!agents) return 'Agents feed still loading — try again in a moment.';

  if (q.includes('attention') || q.includes('urgent') || q.includes('problem')) {
    const need = agents.agents.filter((a) => a.status === 'attention' || a.status === 'blocked');
    if (need.length === 0) return 'Nothing needs you right now. ' + agents.summary.ready + ' agents have output ready.';
    return need.map((a) => `⚠ ${a.name}: ${a.headline}${a.metric ? `  (${a.metric})` : ''}`).join('\n');
  }

  if (q === 'status' || q === 'agents' || (q.includes('what') && q.includes('agent'))) {
    return agents.agents
      .map((a) => {
        const mark = a.status === 'attention' ? '⚠' : a.status === 'ready' ? '✓' : a.status === 'running' ? '…' : '·';
        return `${mark} ${a.name.padEnd(16)} ${a.headline}`;
      })
      .join('\n');
  }

  if (q.includes('issue') || q.includes('seo') || q.includes('on-page') || q.includes('audit')) {
    const seo = agents.agents.find((a) => a.key === 'seo');
    return seo ? `${seo.headline}\n${seo.activity.join('\n')}` : 'No SEO data yet.';
  }

  if (q.includes('visib') || q.includes('geo') || q.includes('citation') || q.includes('mention')) {
    const geo = agents.agents.find((a) => a.key === 'geo');
    return geo ? `${geo.headline}\n${geo.activity.join('\n')}` : 'No GEO data yet.';
  }

  const named = agents.agents.find((a) => q.includes(a.key) || q.includes(a.name.toLowerCase().replace(' agent', '')));
  if (named) return `${named.name}: ${named.headline}\n${named.activity.join('\n')}\n(cta: ${named.cta})`;

  const connected = integrations.filter((i) => i.connected).map((i) => i.name);
  return [
    `I answer from what the dashboard already knows about ${project.domain}.`,
    `Try: status · issues · visibility · attention · connections · gates · help`,
    connected.length ? `Connected: ${connected.join(', ')}` : 'No integrations connected yet — type `connections`.',
  ].join('\n');
}
