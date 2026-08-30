'use client';

/**
 * Cailyx top bar: project switcher, product mark, a typewriter status line, the
 * view menu (show/hide cards, reset/fit the canvas), connections, user
 * management (admin), and the operator chip.
 *
 * @module components/terminal/TopBar
 */

import { useEffect, useRef, useState } from 'react';
import type { User } from '@/types/api';
import type { ProjectDetail } from '@/types/terminal';

const STATUS_LINES = [
  'Initializing AI CMO…',
  'Reading your context…',
  'Agents standing by — ask me anything.',
];

export interface CardToggle {
  key: string;
  title: string;
  visible: boolean;
}

export function TopBar({
  user,
  projects,
  activeId,
  onSelect,
  onNewProject,
  onLogout,
  onOpenConnections,
  onOpenUsers,
  connectedCount,
  cards,
  onToggleCard,
  onResetView,
  onFitView,
  presets,
  onApplyPreset,
  zoom,
}: {
  user: User | null;
  projects: ProjectDetail[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onLogout: () => void;
  onOpenConnections: () => void;
  onOpenUsers: () => void;
  connectedCount: number | null;
  cards: CardToggle[];
  onToggleCard: (key: string) => void;
  onResetView: () => void;
  onFitView: () => void;
  presets: Array<{ id: string; label: string }>;
  onApplyPreset: (id: string) => void;
  zoom: number;
}) {
  const active = projects.find((p) => p.id === activeId) ?? null;
  const [menu, setMenu] = useState<null | 'project' | 'view'>(null);
  const [line, setLine] = useState('');
  const idxRef = useRef(0);

  useEffect(() => {
    let ch = 0;
    let raf: ReturnType<typeof setTimeout>;
    const run = () => {
      const target = STATUS_LINES[idxRef.current % STATUS_LINES.length];
      ch += 1;
      setLine(target.slice(0, ch));
      if (ch < target.length) raf = setTimeout(run, 24);
      else raf = setTimeout(() => { idxRef.current += 1; ch = 0; setLine(''); run(); }, 3600);
    };
    run();
    return () => clearTimeout(raf);
  }, []);

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-bg-raised px-3 text-xs">
      {/* project switcher */}
      <div className="relative">
        <button
          onClick={() => setMenu((m) => (m === 'project' ? null : 'project'))}
          className="flex items-center gap-2 rounded-md border border-border bg-bg-inset px-2 py-1 hover:border-border-strong"
        >
          <span className="text-accent">▚</span>
          <span className="max-w-[160px] truncate">{active ? active.domain : 'no project'}</span>
          <span className="text-faint">▾</span>
        </button>
        {menu === 'project' && (
          <div className="absolute left-0 top-9 z-30 w-64 rounded-md border border-border bg-bg-raised p-1 shadow-xl">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => { onSelect(p.id); setMenu(null); }}
                className={`block w-full truncate rounded px-2 py-1.5 text-left hover:bg-bg-inset ${p.id === activeId ? 'text-accent' : 'text-dim'}`}
              >
                {p.domain}
                <span className="ml-2 text-faint">{p.name}</span>
              </button>
            ))}
            <button
              onClick={() => { onNewProject(); setMenu(null); }}
              className="mt-1 block w-full rounded border-t border-border px-2 py-1.5 text-left text-accent hover:bg-bg-inset"
            >
              + new project
            </button>
          </div>
        )}
      </div>

      <span className="text-faint">·</span>
      <span className="font-semibold tracking-wide text-dim">Cailyx</span>

      <span className="ml-3 hidden truncate text-faint sm:inline">
        <span className="text-accent">&gt;</span> <span className="cursor-blink">{line}</span>
      </span>

      <div className="ml-auto flex items-center gap-2">
        {/* view menu */}
        <div className="relative">
          <button
            onClick={() => setMenu((m) => (m === 'view' ? null : 'view'))}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-inset px-2 py-1 text-dim hover:border-border-strong"
          >
            view <span className="text-faint">{Math.round(zoom * 100)}%</span>
          </button>
          {menu === 'view' && (
            <div className="absolute right-0 top-9 z-30 w-56 rounded-md border border-border bg-bg-raised p-1 shadow-xl">
              <p className="px-2 py-1 text-[10px] uppercase tracking-widest text-faint">layout presets</p>
              <div className="grid grid-cols-2 gap-1 px-1 pb-1">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { onApplyPreset(p.id); setMenu(null); }}
                    className="rounded border border-border px-2 py-1.5 text-left text-[11px] text-dim hover:border-accent-dim hover:text-accent"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="border-t border-border px-2 py-1 pt-1.5 text-[10px] uppercase tracking-widest text-faint">cards</p>
              {cards.map((c) => (
                <button
                  key={c.key}
                  onClick={() => onToggleCard(c.key)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-dim hover:bg-bg-inset"
                >
                  <span className={c.visible ? 'text-accent' : 'text-faint'}>{c.visible ? '☑' : '☐'}</span>
                  {c.title}
                </button>
              ))}
              <div className="mt-1 border-t border-border pt-1">
                <button onClick={() => { onFitView(); setMenu(null); }} className="block w-full rounded px-2 py-1.5 text-left text-faint hover:bg-bg-inset hover:text-dim">
                  fit all cards
                </button>
                <button onClick={() => { onResetView(); setMenu(null); }} className="block w-full rounded px-2 py-1.5 text-left text-faint hover:bg-bg-inset hover:text-dim">
                  reset view
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onOpenConnections}
          className="rounded-md border border-border bg-bg-inset px-2 py-1 text-dim hover:border-border-strong"
        >
          connections{connectedCount !== null ? ` (${connectedCount})` : ''}
        </button>

        {user?.role === 'admin' && (
          <button
            onClick={onOpenUsers}
            className="rounded-md border border-border bg-bg-inset px-2 py-1 text-dim hover:border-border-strong"
          >
            users
          </button>
        )}

        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-accent-dim/30 text-[10px] text-accent">
            {(user?.name ?? '?').slice(0, 2).toUpperCase()}
          </span>
          <div className="hidden leading-tight md:block">
            <div className="text-dim">{user?.name ?? '…'}</div>
            <div className="text-[10px] text-faint">{user?.role ?? ''}</div>
          </div>
          <button onClick={onLogout} title="Log out" className="ml-1 rounded p-1 text-faint hover:text-dim">
            ⎋
          </button>
        </div>
      </div>
    </div>
  );
}
