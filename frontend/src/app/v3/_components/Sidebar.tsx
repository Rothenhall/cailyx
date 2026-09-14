'use client';

/**
 * Sidebar — /v3's actual navigation: a labeled left rail with real routes,
 * a project switcher, and account controls at the bottom. Replaces /v2's
 * 72px icon-only NavRail (moved into the topbar-adjacent canvas) plus the
 * project-switcher/user-menu half of its TopBar — a normal dashboard shape
 * instead of the console-as-canvas one.
 *
 * @module app/v3/_components/Sidebar
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { User } from '@/types/api';
import type { ProjectDetail } from '@/types/terminal';
import {
  BarIcon,
  BoltIcon,
  BrandMark,
  ChevronDown,
  GridIcon,
  LayersIcon,
  LogoutIcon,
  PlugIcon,
  PlusIcon,
  SyncIcon,
  UsersIcon,
} from './icons';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  prefix?: boolean;
}

const ITEMS: NavItem[] = [
  { href: '/v3', label: 'Overview', icon: <GridIcon className="h-4 w-4" /> },
  { href: '/v3/presence', label: 'Presence', icon: <LayersIcon className="h-4 w-4" /> },
  { href: '/v3/audits', label: 'Audits', icon: <BarIcon className="h-4 w-4" />, prefix: true },
  { href: '/v3/rivals', label: 'Rivals', icon: <UsersIcon className="h-4 w-4" /> },
  { href: '/v3/keywords', label: 'Keywords', icon: <SyncIcon className="h-4 w-4" /> },
  { href: '/v3/agents', label: 'Agents', icon: <BoltIcon className="h-4 w-4" /> },
  { href: '/v3/reports', label: 'Reports', icon: <BarIcon className="h-4 w-4" /> },
];

export function Sidebar({
  user,
  projects,
  activeId,
  onSelect,
  onNewProject,
  onLogout,
  onOpenConnections,
  onOpenUsers,
  connectedCount,
  disabled,
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
  disabled?: boolean;
}) {
  const pathname = usePathname();
  const active = projects.find((p) => p.id === activeId) ?? null;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) setSwitcherOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSwitcherOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [switcherOpen]);

  const initials = (user?.name ?? '?').trim().slice(0, 2).toUpperCase();

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-bg-raised">
      <div className="flex items-center gap-2 px-4 py-4">
        <BrandMark className="h-5 w-5" />
        <span className="text-title font-semibold tracking-tight2 text-text">Cailyx</span>
      </div>

      <div ref={switcherRef} className="relative px-3 pb-3">
        <button
          type="button"
          onClick={() => setSwitcherOpen((v) => !v)}
          className={`flex w-full items-center gap-2 rounded-r3 border px-3 py-2.5 text-left transition-colors ${
            switcherOpen ? 'border-border-strong' : 'border-border hover:border-border-strong'
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="text-eyebrow uppercase tracking-eyebrow text-faint">project</div>
            <div className="truncate text-ui font-medium text-text">{active ? active.domain : 'none selected'}</div>
          </div>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
        </button>
        {switcherOpen && (
          <div className="absolute left-3 right-3 top-full z-30 mt-1.5 overflow-hidden rounded-r3 border border-border bg-bg-raised p-1.5 shadow-e3">
            <div className="max-h-72 overflow-y-auto">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onSelect(p.id);
                    setSwitcherOpen(false);
                  }}
                  className={`flex w-full flex-col rounded-r2 px-2.5 py-2 text-left hover:bg-bg-inset ${
                    p.id === activeId ? 'bg-bg-inset' : ''
                  }`}
                >
                  <span className={`truncate text-ui ${p.id === activeId ? 'font-semibold text-accent' : 'text-text'}`}>
                    {p.domain}
                  </span>
                  <span className="truncate text-caption text-faint">{p.name}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                onNewProject();
                setSwitcherOpen(false);
              }}
              className="mt-1 flex w-full items-center gap-1.5 rounded-r2 border-t border-border px-2.5 py-2 text-left text-ui font-medium text-accent hover:bg-bg-inset"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              new project
            </button>
          </div>
        )}
      </div>

      <nav aria-label="Console sections" className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {ITEMS.map((it) => {
          const on = it.prefix ? pathname === it.href || pathname.startsWith(`${it.href}/`) : pathname === it.href;
          const off = disabled && it.href !== '/v3';
          return (
            <Link
              key={it.href}
              href={off ? '#' : it.href}
              aria-disabled={off}
              aria-current={on ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-r2 px-3 py-2 text-ui transition-colors duration-micro ${
                on
                  ? 'bg-accent-dim/20 font-medium text-accent'
                  : off
                    ? 'pointer-events-none text-faint/40'
                    : 'text-dim hover:bg-bg-inset hover:text-text'
              }`}
            >
              {it.icon}
              {it.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-1 border-t border-border p-3">
        <button
          type="button"
          onClick={onOpenConnections}
          className="flex w-full items-center gap-2.5 rounded-r2 px-3 py-2 text-ui text-dim transition-colors hover:bg-bg-inset hover:text-text"
        >
          <PlugIcon className="h-4 w-4" />
          Connections
          {connectedCount !== null && (
            <span className="tabular-nums ml-auto rounded-r2 bg-accent-dim/24 px-1.5 text-caption font-medium text-accent">
              {connectedCount}
            </span>
          )}
        </button>
        {user?.role === 'admin' && (
          <button
            type="button"
            onClick={onOpenUsers}
            className="flex w-full items-center gap-2.5 rounded-r2 px-3 py-2 text-ui text-dim transition-colors hover:bg-bg-inset hover:text-text"
          >
            <UsersIcon className="h-4 w-4" />
            Team
          </button>
        )}

        <div className="mt-1 flex items-center gap-2.5 border-t border-border pt-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-dim/24 text-body font-semibold text-accent">
            {initials}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-ui font-medium text-text">{user?.name ?? '…'}</div>
            <div className="truncate text-caption capitalize text-faint">{user?.role ?? ''}</div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            title="Log out"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-r2 border border-transparent text-faint transition-colors hover:border-border hover:bg-bg-inset hover:text-dim"
          >
            <LogoutIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
