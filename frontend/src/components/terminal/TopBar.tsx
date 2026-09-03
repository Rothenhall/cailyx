'use client';

/**
 * Cailyx top bar: brand lockup, project switcher, and a GooeyNav control group
 * (view / connections / users) that behaves as one connected liquid-pill row.
 * Restyled on Urbanist; paints only from the Rothenhall theme tokens.
 *
 * @module components/terminal/TopBar
 */

import { useEffect, useRef, useState } from 'react';
import type { User } from '@/types/api';
import type { ProjectDetail } from '@/types/terminal';
import { GooeyNav, type GooeyItem } from './GooeyNav';

export interface CardToggle {
  key: string;
  title: string;
  visible: boolean;
}

/* ── inline icons (16px grid, inherit color via currentColor) ──────────── */
type IconProps = { className?: string };

function BrandMark({ className }: IconProps) {
  // three ascending squares — brass staircase, echoes the login mark
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden>
      <rect x="1" y="11" width="7" height="7" rx="1.5" fill="var(--accent-dim)" />
      <rect x="7" y="6" width="7" height="7" rx="1.5" fill="var(--accent)" />
      <rect x="13" y="1" width="6" height="6" rx="1.5" fill="var(--cognac)" />
    </svg>
  );
}
function ChevronDown({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
function LayersIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 1.75l6 3-6 3-6-3 6-3z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11l6 3 6-3" />
    </svg>
  );
}
function PlugIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 2v3M10 2v3" />
      <path d="M4 5h8v2a4 4 0 0 1-8 0V5z" />
      <path d="M8 11v3" />
    </svg>
  );
}
function UsersIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
      <path d="M11 4a2.3 2.3 0 0 1 0 4.4M14.5 13c0-2-1-3.2-2.8-3.7" />
    </svg>
  );
}
function LogoutIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
      <path d="M10.5 11L14 8l-3.5-3M14 8H6" />
    </svg>
  );
}
function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}
function CheckSquare({ on, className }: IconProps & { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      {on && <path d="M4.75 8.25l2 2 4.5-4.5" />}
    </svg>
  );
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
  const barRef = useRef<HTMLElement>(null);

  // close any open menu on outside click / Escape
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const initials = (user?.name ?? '?').trim().slice(0, 2).toUpperCase();

  const gooItems: GooeyItem[] = [
    {
      key: 'view',
      title: 'Layout & cards',
      icon: <LayersIcon className="h-4 w-4" />,
      label: (
        <>
          view <span className="tabular-nums text-faint">{Math.round(zoom * 100)}%</span>
        </>
      ),
      onClick: () => setMenu((m) => (m === 'view' ? null : 'view')),
      active: menu === 'view',
    },
    {
      key: 'connections',
      title: 'Connections',
      icon: <PlugIcon className="h-4 w-4" />,
      label: (
        <>
          connections
          {connectedCount !== null && (
            <span className="tabular-nums rounded-md bg-accent-dim/30 px-1.5 text-[11px] font-medium text-accent">
              {connectedCount}
            </span>
          )}
        </>
      ),
      onClick: onOpenConnections,
    },
    ...(user?.role === 'admin'
      ? [
          {
            key: 'users',
            title: 'User management',
            icon: <UsersIcon className="h-4 w-4" />,
            label: 'users',
            onClick: onOpenUsers,
          } as GooeyItem,
        ]
      : []),
  ];

  return (
    <header
      ref={barRef}
      className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg-raised px-4"
    >
      {/* brand lockup */}
      <div className="flex items-center gap-2 pr-1">
        <BrandMark className="h-5 w-5" />
        <span className="text-[15px] font-semibold tracking-tight text-text">Cailyx</span>
      </div>

      <span className="h-6 w-px bg-border" />

      {/* project switcher */}
      <div className="relative">
        <button
          onClick={() => setMenu((m) => (m === 'project' ? null : 'project'))}
          className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] transition-colors ${
            menu === 'project'
              ? 'border-border-strong text-text'
              : 'border-border text-dim hover:border-border-strong hover:text-text'
          }`}
        >
          <span className="text-[11px] uppercase tracking-wider text-faint">project</span>
          <span className="max-w-[180px] truncate font-medium text-text">
            {active ? active.domain : 'none selected'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-faint" />
        </button>
        {menu === 'project' && (
          <div className="absolute left-0 top-full z-30 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-bg-raised p-1.5 shadow-xl">
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] uppercase tracking-widest text-faint">
              switch project
            </p>
            <div className="max-h-72 overflow-y-auto">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelect(p.id);
                    setMenu(null);
                  }}
                  className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-bg-inset ${
                    p.id === activeId ? 'bg-bg-inset' : ''
                  }`}
                >
                  <span className={`truncate text-[13px] ${p.id === activeId ? 'font-semibold text-accent' : 'text-text'}`}>
                    {p.domain}
                  </span>
                  <span className="truncate text-[11px] text-faint">{p.name}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                onNewProject();
                setMenu(null);
              }}
              className="mt-1 flex w-full items-center gap-1.5 rounded-lg border-t border-border px-2.5 py-2 text-left text-[13px] font-medium text-accent hover:bg-bg-inset"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              new project
            </button>
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* gooey control group + the view dropdown it anchors */}
        <div className="relative">
          <GooeyNav items={gooItems} />
          {menu === 'view' && (
            <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-border bg-bg-raised p-1.5 shadow-xl">
              <p className="px-2.5 py-1 text-[10px] uppercase tracking-widest text-faint">layout presets</p>
              <div className="grid grid-cols-2 gap-1.5 px-1 pb-1.5">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      onApplyPreset(p.id);
                      setMenu(null);
                    }}
                    className="rounded-lg border border-border px-2.5 py-2 text-left text-[12px] text-dim hover:border-accent-dim hover:text-accent"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="border-t border-border px-2.5 py-1 pt-2 text-[10px] uppercase tracking-widest text-faint">cards</p>
              {cards.map((c) => (
                <button
                  key={c.key}
                  onClick={() => onToggleCard(c.key)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-dim hover:bg-bg-inset"
                >
                  <CheckSquare on={c.visible} className={`h-4 w-4 ${c.visible ? 'text-accent' : 'text-faint'}`} />
                  {c.title}
                </button>
              ))}
              <div className="mt-1 border-t border-border pt-1">
                <button
                  onClick={() => {
                    onFitView();
                    setMenu(null);
                  }}
                  className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-faint hover:bg-bg-inset hover:text-dim"
                >
                  fit all cards
                </button>
                <button
                  onClick={() => {
                    onResetView();
                    setMenu(null);
                  }}
                  className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-faint hover:bg-bg-inset hover:text-dim"
                >
                  reset view
                </button>
              </div>
            </div>
          )}
        </div>

        <span className="h-6 w-px bg-border" />

        {/* account */}
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-dim/30 text-[11px] font-semibold text-accent">
            {initials}
          </span>
          <div className="hidden leading-tight md:block">
            <div className="text-[13px] font-medium text-text">{user?.name ?? '…'}</div>
            <div className="text-[11px] capitalize text-faint">{user?.role ?? ''}</div>
          </div>
          <button
            onClick={onLogout}
            title="Log out"
            className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-faint transition-colors hover:border-border hover:bg-bg-inset hover:text-dim"
          >
            <LogoutIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
