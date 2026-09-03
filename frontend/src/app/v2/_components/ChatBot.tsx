'use client';

/**
 * ChatBot — /v2. The Cailyx Assistant: a frosted panel that sits under the
 * agent grid. Refined message cards with sender labels + entrance motion, a
 * glass composer with quick-command chips and a typing indicator.
 *
 * The responder is deterministic (no LLM, no spend) and answers from what the
 * console already fetched: the project row, the agents rollup and the
 * integrations list. Queries handed over from the Flywheel or the Agents Feed
 * arrive through `seed`.
 *
 * @module app/v2/_components/ChatBot
 */

import { useEffect, useRef, useState } from 'react';
import type { AgentsResponse, Integration, ProjectDetail } from '@/types/terminal';
import { SendIcon } from './icons';

interface Msg {
  role: 'user' | 'bot';
  text: string;
}

/** what the Flywheel / Agents Feed can hand over */
export interface ChatSeed {
  /** bumped on every hand-off so repeats of the same text still fire */
  id: number;
  kind: 'query' | 'agent';
  text: string;
}

const HELP = [
  'Commands',
  'status — what every agent is doing',
  'issues — top on-page problems',
  'visibility — AI mention & citation rates',
  'connections — integration status',
  'gates — what still needs configuring',
  'attention — only what needs you',
  'context — the company profile',
].join('\n');

const QUICK = ['status', 'issues', 'visibility'];

/* the responder can ask the page to open a panel instead of replying */
const OPEN_CONNECTIONS = '__CONNECTIONS__';

interface Ctx {
  project: ProjectDetail | null;
  agents: AgentsResponse | null;
  integrations: Integration[];
}

/* ── deterministic responder (ported from the v1 ChatPane) ─────────────── */
function respond(raw: string, { project, agents, integrations }: Ctx): string {
  const q = raw.toLowerCase().trim();

  if (q === 'help' || q === '?') return HELP;
  if (!project) return 'No project selected. Pick one from the switcher up top.';
  if (q.includes('connection') || q.includes('integration')) return OPEN_CONNECTIONS;

  if (q === 'gates' || q.includes('blocked') || q.includes('pending')) {
    const blocked = integrations.filter((i) => i.category !== 'mode' && !i.connected);
    return blocked.length === 0
      ? 'No integration gates open.'
      : 'Needs a key: ' + blocked.map((i) => `${i.name} (${i.configHint})`).join('; ') + '.';
  }

  if (q === 'context' || q.includes('profile') || q.includes('company')) {
    return [
      `${project.name} — ${project.domain}`,
      project.category ? `category: ${project.category}` : null,
      project.notes || '(no description yet — add one in the Context drawer)',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (!agents) return 'Agents feed still loading — try again in a moment.';

  if (q.includes('attention') || q.includes('urgent') || q.includes('problem')) {
    const need = agents.agents.filter((a) => a.status === 'attention' || a.status === 'blocked');
    return need.length === 0
      ? `Nothing needs you right now. ${agents.summary.ready} agents have output ready.`
      : need.map((a) => `⚠ ${a.name}: ${a.headline}${a.metric ? ` (${a.metric})` : ''}`).join('\n');
  }

  if (q === 'status' || q === 'agents' || (q.includes('what') && q.includes('agent'))) {
    return agents.agents
      .map((a) => {
        const mark = a.status === 'attention' ? '⚠' : a.status === 'ready' ? '✓' : a.status === 'running' ? '…' : '·';
        return `${mark} ${a.name} — ${a.headline}`;
      })
      .join('\n');
  }

  if (q.includes('issue') || q.includes('seo') || q.includes('on-page') || q.includes('audit')) {
    const seo = agents.agents.find((a) => a.key === 'seo');
    return seo ? `${seo.headline}\n${seo.activity.join('\n') || '(no activity yet)'}` : 'No SEO data yet.';
  }

  if (q.includes('visib') || q.includes('geo') || q.includes('citation') || q.includes('mention')) {
    const geo = agents.agents.find((a) => a.key === 'geo');
    return geo ? `${geo.headline}\n${geo.activity.join('\n') || '(no activity yet)'}` : 'No GEO data yet.';
  }

  const named = agents.agents.find((a) => q.includes(a.key) || q.includes(a.name.toLowerCase().replace(' agent', '')));
  if (named) {
    return `${named.name}: ${named.headline}\n${named.activity.join('\n') || '(no activity yet)'}\nnext: ${named.cta}`;
  }

  if (/\b(hi|hey|hello)\b/.test(q)) return 'Ready. Try `status`, `issues`, `visibility`, or `help`.';

  const connected = integrations.filter((i) => i.connected).map((i) => i.name);
  return [
    `I answer from what the console already knows about ${project.domain}.`,
    'Try: status · issues · visibility · attention · connections · gates · help',
    connected.length ? `Connected: ${connected.join(', ')}` : 'No integrations connected yet — type `connections`.',
  ].join('\n');
}

/* ── one message ──────────────────────────────────────────────────────── */
function Bubble({ m }: { m: Msg }) {
  const isUser = m.role === 'user';
  const lines = m.text.split('\n');
  const multiline = lines.length > 1;
  return (
    <div className={`v2msg-in flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      {!isUser && (
        <div className="mb-1 flex items-center gap-1.5 pl-0.5">
          <span className="grid h-4 w-4 place-items-center rounded-full bg-accent-dim/40 text-caption font-semibold text-accent">
            C
          </span>
          <span className="text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">Assistant</span>
        </div>
      )}
      <div
        className={
          isUser
            ? 'v2bubble-user max-w-[86%] rounded-r4 rounded-br-md px-3 py-2 text-body text-text'
            : 'v2bubble-bot max-w-[94%] rounded-r4 rounded-bl-md px-3 py-2 text-body leading-relaxed text-dim'
        }
      >
        {multiline ? (
          <span className="flex flex-col gap-1 break-words">
            {lines.map((line, li) => (
              <span key={li} className={li === 0 && !isUser ? 'text-body font-semibold text-text' : undefined}>
                {line}
              </span>
            ))}
          </span>
        ) : (
          <span className="whitespace-pre-wrap break-words">{m.text}</span>
        )}
      </div>
    </div>
  );
}

export function ChatBot({
  project,
  agents,
  integrations,
  seed,
  onOpenConnections,
}: {
  project: ProjectDetail | null;
  agents: AgentsResponse | null;
  integrations: Integration[];
  /** a query / agent handed over from another surface */
  seed: ChatSeed | null;
  onOpenConnections: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  /* live context for the responder — read at send time, never stale */
  const ctx = useRef<Ctx>({ project, agents, integrations });
  ctx.current = { project, agents, integrations };

  /* reset the transcript when the console switches project */
  useEffect(() => {
    setMsgs([
      {
        role: 'bot',
        text: project
          ? `Ready. Ask me anything about ${project.domain}, or type \`help\`.`
          : 'Create or select a project to begin.',
      },
    ]);
  }, [project?.id, project?.domain]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, pending]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [input]);

  const reply = (text: string) => {
    if (text === OPEN_CONNECTIONS) {
      onOpenConnections();
      setMsgs((m) => [...m, { role: 'bot', text: 'Opened the workspace connections panel.' }]);
      return;
    }
    setMsgs((m) => [...m, { role: 'bot', text }]);
  };

  const sendText = (raw: string) => {
    const q = raw.trim();
    if (!q || pending) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: q }]);
    setPending(true);
    setTimeout(() => {
      reply(respond(q, ctx.current));
      setPending(false);
    }, 420);
  };

  /* a query / agent dropped in from the Flywheel or the Agents Feed */
  useEffect(() => {
    if (!seed) return;
    if (seed.kind === 'agent') {
      setMsgs((m) => [...m, { role: 'user', text: seed.text }]);
      setPending(true);
      const t = setTimeout(() => {
        reply(respond(seed.text, ctx.current));
        setPending(false);
      }, 420);
      return () => clearTimeout(t);
    }
    setMsgs((m) => [
      ...m,
      { role: 'user', text: seed.text },
      {
        role: 'bot',
        text:
          `Suggested buyer query: "${seed.text}".\n` +
          'Add it to a query set, or plan a journey from it — the Journey agent will branch it into a full search path.',
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.id]);

  const atStart = msgs.length <= 1 && !pending;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-r4 bg-bg-raised/25 backdrop-blur-[1.5px]">
      {/* header */}
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-3">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-dim/30 text-body font-semibold text-accent ring-1 ring-accent-dim/40">
          C
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-body font-semibold text-text">Cailyx Assistant</div>
          <div className="flex items-center gap-1 truncate text-caption text-faint">
            <span className="h-1 w-1 shrink-0 rounded-full bg-accent" />
            <span className="truncate">
              {project ? `answers from ${project.domain}` : 'no project selected'}
            </span>
          </div>
        </div>
        <button
          onClick={() =>
            setMsgs((m) => [
              ...m,
              {
                role: 'bot',
                text: 'Engagements: fixed-fee sprint · monthly operating retainer · portfolio-wide retainer.\nCheckout links come from the delivery module once Stripe is configured — type `connections`.',
              },
            ])
          }
          className="ml-auto shrink-0 whitespace-nowrap text-caption font-medium text-faint transition-colors hover:text-accent"
        >
          Hire a CMO &rarr;
        </button>
      </div>

      <div className="v2hair mx-3" />

      {/* transcript */}
      <div className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-x-2 inset-y-2 -z-10 rounded-r4 backdrop-blur-3xl backdrop-saturate-150" />
        <div ref={scroller} className="flex h-full flex-col gap-2.5 overflow-y-auto px-4 py-3">
          <div className="flex-1" />
          {msgs.map((m, i) => (
            <Bubble key={i} m={m} />
          ))}
          {pending && (
            <div className="v2msg-in flex flex-col items-start">
              <div className="mb-1 flex items-center gap-1.5 pl-0.5">
                <span className="grid h-4 w-4 place-items-center rounded-full bg-accent-dim/40 text-caption font-semibold text-accent">
                  C
                </span>
                <span className="text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">Assistant</span>
              </div>
              <div className="v2bubble-bot flex items-center gap-1 rounded-r4 rounded-bl-md px-3 py-2.5">
                <span className="v2dot h-1.5 w-1.5 rounded-full bg-accent-dim" />
                <span className="v2dot h-1.5 w-1.5 rounded-full bg-accent-dim" />
                <span className="v2dot h-1.5 w-1.5 rounded-full bg-accent-dim" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* composer zone */}
      <div className="px-3 pb-3 pt-1">
        {atStart && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK.map((c) => (
              <button
                key={c}
                onClick={() => sendText(c)}
                className="rounded-full border border-border bg-bg-raised px-2.5 py-1 text-caption text-dim transition-colors hover:border-accent-dim hover:text-accent"
              >
                {c}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendText(input);
          }}
        >
          <div className="v2composer flex items-end gap-2 rounded-r4 border border-border bg-bg-raised px-3 py-2.5 transition-colors focus-within:border-border-strong">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendText(input);
                }
              }}
              rows={1}
              placeholder={project ? 'Ask anything…' : 'Select a project first…'}
              className="max-h-[120px] flex-1 resize-none bg-transparent py-0.5 text-body leading-relaxed text-text outline-none placeholder:text-faint"
            />
            <button
              type="submit"
              disabled={!input.trim() || pending}
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition-all ${
                input.trim() && !pending ? 'bg-accent text-bg-raised' : 'text-faint'
              }`}
              aria-label="Send"
            >
              <SendIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-1.5 px-1 text-eyebrow text-faint">
            <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift</kbd>+<kbd className="font-sans">Enter</kbd> for a new line
          </div>
        </form>
      </div>
    </div>
  );
}
