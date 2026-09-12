'use client';

/**
 * NavRail — /v2. The console's first actual navigation.
 *
 * Before this, nothing had a home. The console was a fixed three-band canvas
 * plus four full-screen workspaces, each reached from inside an unrelated
 * surface: competitors lived four clicks deep behind an agent card, tech stack
 * was the fifth section of the Technical audit, and keyword research had no
 * route at all. A module with no home gets wedged behind whatever surface is
 * nearest, which is how a workspace ends up unfindable — and a workspace nobody
 * can find is a workspace that does not exist.
 *
 * The rail is deliberately thin on content: it is a router, not a dashboard. It
 * shows where you are and what else there is, and nothing else. Counts and
 * badges are resisted on purpose — a nav that reports state has to be kept in
 * sync with that state, and a stale badge is worse than none.
 *
 * @module app/v2/_components/NavRail
 */

import type { ReactNode } from 'react';
import { BarIcon, BoltIcon, GridIcon, LayersIcon, SyncIcon, UsersIcon } from './icons';

/** Top-level destinations. `overview` is the original three-band canvas. */
export type Section =
  | 'overview'
  | 'presence'
  | 'audits'
  | 'competitors'
  | 'keywords'
  | 'agents'
  | 'deliverables';

interface NavItem {
  id: Section;
  label: string;
  hint: string;
  icon: ReactNode;
}

/**
 * Reading order follows the delivery flow, not module size: what do we know
 * about them (presence) → how good is it (audits) → how do they compare
 * (competitors) → what should we target (keywords) → what ran (agents) → what
 * does the client get (deliverables).
 */
const ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', hint: 'Flywheel, audits, agents', icon: <GridIcon className="h-4 w-4" /> },
  { id: 'presence', label: 'Presence', hint: 'Accounts, gaps, footprint', icon: <LayersIcon className="h-4 w-4" /> },
  { id: 'audits', label: 'Audits', hint: 'Technical, SEO, AEO', icon: <BarIcon className="h-4 w-4" /> },
  { id: 'competitors', label: 'Rivals', hint: 'Gap vs competitors', icon: <UsersIcon className="h-4 w-4" /> },
  { id: 'keywords', label: 'Keywords', hint: 'Demand research', icon: <SyncIcon className="h-4 w-4" /> },
  { id: 'agents', label: 'Agents', hint: 'Run and read', icon: <BoltIcon className="h-4 w-4" /> },
  { id: 'deliverables', label: 'Reports', hint: 'What the client gets', icon: <BarIcon className="h-4 w-4" /> },
];

export function NavRail({
  section,
  onSelect,
  disabled,
}: {
  section: Section;
  onSelect: (s: Section) => void;
  /** No project selected — every section but Overview has nothing to show. */
  disabled?: boolean;
}) {
  return (
    <nav
      aria-label="Console sections"
      className="v2-rail flex shrink-0 flex-col gap-0.5 border-r border-border bg-bg-raised/40 py-2"
    >
      {ITEMS.map((it) => {
        const on = section === it.id;
        // Overview stays reachable with no project: it is where a project gets
        // chosen, so disabling it would strand the operator.
        const off = disabled && it.id !== 'overview';
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => !off && onSelect(it.id)}
            disabled={off}
            title={off ? 'Select a project first' : it.hint}
            aria-current={on ? 'page' : undefined}
            className={`group relative flex flex-col items-center gap-1 px-2 py-2 transition-colors duration-micro ${
              on ? 'text-accent' : off ? 'text-faint/40' : 'text-faint hover:text-dim'
            } ${off ? 'cursor-not-allowed' : ''}`}
          >
            {/* The active marker is a bar on the rail's own edge rather than a
                filled pill: at this width a pill crowds the label out. */}
            <span
              className={`absolute left-0 top-1 h-[calc(100%-0.5rem)] w-0.5 rounded-r-full transition-colors ${
                on ? 'bg-accent' : 'bg-transparent'
              }`}
            />
            {it.icon}
            <span className="w-full truncate text-center text-eyebrow font-medium leading-none tracking-tight2">
              {it.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
