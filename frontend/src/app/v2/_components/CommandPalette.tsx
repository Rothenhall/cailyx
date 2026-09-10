'use client';

/**
 * CommandPalette — ⌘K / Ctrl-K.
 *
 * The console had no keyboard model at all: every action required finding a
 * control with the mouse, and the agent roster is twelve tiles deep. This is
 * the one surface that reaches everything — jump to an agent, switch project,
 * open the workspace panels, refresh, log out.
 *
 * Matching is a plain subsequence test, which is what makes "sq" find "Search
 * quality" and "rv" find "Rivals" without a fuzzy-search dependency.
 *
 * @module app/v2/_components/CommandPalette
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../_lib/useFocusTrap';
import { AgentIcon, ArrowRight, BoltIcon, LogoutIcon, PlugIcon, PlusIcon, SyncIcon, UsersIcon } from './icons';

export interface Command {
  id: string;
  /** what the operator reads */
  label: string;
  /** the group it files under */
  group: 'Agents' | 'Projects' | 'Workspace';
  /** extra text matched against, never shown */
  keywords?: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** every character of `q` appears in `text`, in order */
function matches(text: string, q: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = t.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useFocusTrap(open, card);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const hits = useMemo(
    () => commands.filter((c) => matches(`${c.label} ${c.keywords ?? ''} ${c.group}`, q.trim())),
    [commands, q],
  );

  useEffect(() => {
    setActive(0);
  }, [q]);

  /* keep the highlighted row in view while arrowing through a long list */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (hits.length ? (i + 1) % hits.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = hits[active];
        if (c) {
          onClose();
          c.run();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hits, active, onClose]);

  if (!open) return null;

  /* group headers are drawn when the group changes, so the list stays flat
     for arrow navigation while still reading as sections */
  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-[75] flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-[#1a1712]/40 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="v2-pop relative flex max-h-[62vh] w-full max-w-lg flex-col overflow-hidden rounded-r4 border border-border bg-bg-raised shadow-e3"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="text-faint">
            <BoltIcon className="h-4 w-4" />
          </span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to an agent, switch project, open settings…"
            aria-label="Search commands"
            className="min-w-0 flex-1 bg-transparent text-ui text-text outline-none placeholder:text-faint"
          />
          <kbd className="shrink-0 rounded-r1 border border-border px-1.5 py-0.5 text-eyebrow uppercase text-faint">
            esc
          </kbd>
        </div>

        <ul ref={listRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
          {hits.length === 0 && (
            <li className="px-3 py-6 text-center text-body text-faint">Nothing matches “{q}”.</li>
          )}
          {hits.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id}>
                {header && (
                  <p className="px-2.5 pb-1 pt-2.5 text-eyebrow uppercase text-faint">{header}</p>
                )}
                <button
                  type="button"
                  data-i={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    onClose();
                    c.run();
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-r2 px-2.5 py-2 text-left transition-colors duration-micro ${
                    i === active ? 'bg-accent-dim/24 text-text' : 'text-dim hover:bg-bg-inset'
                  }`}
                >
                  <span className={`shrink-0 ${i === active ? 'text-accent' : 'text-faint'}`}>{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-body">{c.label}</span>
                  {c.hint && <span className="shrink-0 text-caption text-faint">{c.hint}</span>}
                  {i === active && <ArrowRight className="h-3 w-3 shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 text-caption text-faint">
          <span>
            <kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> move
          </span>
          <span>
            <kbd className="font-sans">↵</kbd> run
          </span>
          <span className="ml-auto">{hits.length} of {commands.length}</span>
        </div>
      </div>
    </div>
  );
}

/* icons re-exported so the page can build commands without importing twice */
export const CmdIcons = { AgentIcon, PlugIcon, UsersIcon, PlusIcon, SyncIcon, LogoutIcon };
