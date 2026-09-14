'use client';

/**
 * Topbar — deliberately sparse. The project switcher, nav, and account
 * controls all moved into Sidebar.tsx; this only carries the command-palette
 * affordance and a "new project" quick action, so it stays useful at any
 * scroll position without duplicating what the sidebar already shows.
 *
 * @module app/v3/_components/Topbar
 */

import { PlusIcon } from './icons';

export function Topbar({ onNewProject, onOpenPalette }: { onNewProject: () => void; onOpenPalette: () => void }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b border-border bg-bg px-6">
      <button
        type="button"
        onClick={onOpenPalette}
        title="Command palette"
        aria-label="Open command palette"
        aria-keyshortcuts="Meta+K Control+K"
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1.5 text-caption text-faint transition-colors duration-micro hover:border-border-strong hover:text-dim"
      >
        Search
        <kbd className="rounded-r1 border border-border px-1 text-eyebrow uppercase">⌘K</kbd>
      </button>
      <button
        type="button"
        onClick={onNewProject}
        className="inline-flex items-center gap-1.5 rounded-r2 bg-accent px-3 py-1.5 text-ui font-medium text-bg-raised transition-colors hover:bg-accent/90"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        New project
      </button>
    </header>
  );
}
