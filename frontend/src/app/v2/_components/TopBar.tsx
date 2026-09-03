'use client';

/**
 * TopBar — /v2 copy. Brand lockup, project switcher, and a GooeyNav control
 * group (connections / users) that opens the grouped <SettingsPanel>.
 * Independent of the shared component — the live console (`/`) is unaffected.
 *
 * @module app/v2/_components/TopBar
 */

import { useEffect, useRef, useState } from 'react';
import type { User } from '@/types/api';
import type { ProjectDetail } from '@/types/terminal';
import { GooeyNav, type GooeyItem } from './GooeyNav';
import { BrandMark, ChevronDown, LogoutIcon, PlugIcon, PlusIcon, UsersIcon } from './icons';

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
}) {
  const active = projects.find((p) => p.id === activeId) ?? null;
  const [menu, setMenu] = useState<null | 'project'>(null);
  const barRef = useRef<HTMLElement>(null);

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
      key: 'connections',
      title: 'Connections',
      icon: <PlugIcon className="h-4 w-4" />,
      label: (
        <>
          connections
          {connectedCount !== null && (
            <span className="tabular-nums rounded-md bg-accent-dim/30 px-1.5 text-body font-medium text-accent">
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
      <div className="flex items-center gap-2 pr-1">
        <BrandMark className="h-5 w-5" />
        <span className="text-title font-semibold tracking-tight2 text-text">Cailyx</span>
      </div>

      <span className="h-6 w-px bg-border" />

      <div className="relative">
        <button
          onClick={() => setMenu((m) => (m === 'project' ? null : 'project'))}
          className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-ui transition-colors ${
            menu === 'project'
              ? 'border-border-strong text-text'
              : 'border-border text-dim hover:border-border-strong hover:text-text'
          }`}
        >
          <span className="text-body uppercase tracking-eyebrow text-faint">project</span>
          <span className="max-w-[180px] truncate font-medium text-text">
            {active ? active.domain : 'none selected'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-faint" />
        </button>
        {menu === 'project' && (
          <div className="absolute left-0 top-full z-30 mt-2 w-72 overflow-hidden rounded-r3 border border-border bg-bg-raised p-1.5 shadow-xl">
            <p className="px-2.5 pb-1 pt-1.5 text-caption uppercase tracking-eyebrow text-faint">
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
                  className={`flex w-full items-baseline gap-2 rounded-r2 px-2.5 py-2 text-left hover:bg-bg-inset ${
                    p.id === activeId ? 'bg-bg-inset' : ''
                  }`}
                >
                  <span className={`truncate text-ui ${p.id === activeId ? 'font-semibold text-accent' : 'text-text'}`}>
                    {p.domain}
                  </span>
                  <span className="truncate text-body text-faint">{p.name}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                onNewProject();
                setMenu(null);
              }}
              className="mt-1 flex w-full items-center gap-1.5 rounded-r2 border-t border-border px-2.5 py-2 text-left text-ui font-medium text-accent hover:bg-bg-inset"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              new project
            </button>
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <GooeyNav items={gooItems} />

        <span className="h-6 w-px bg-border" />

        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-dim/30 text-body font-semibold text-accent">
            {initials}
          </span>
          <div className="hidden leading-tight md:block">
            <div className="text-ui font-medium text-text">{user?.name ?? '…'}</div>
            <div className="text-body capitalize text-faint">{user?.role ?? ''}</div>
          </div>
          <button
            onClick={onLogout}
            title="Log out"
            className="grid h-8 w-8 place-items-center rounded-r2 border border-transparent text-faint transition-colors hover:border-border hover:bg-bg-inset hover:text-dim"
          >
            <LogoutIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
