'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { isActiveHref, type NavSection } from '@/lib/navigation';

/**
 * The shared shell frame for every signed-in surface.
 *
 * design_plan.md §3.1 fixes the layout constants: a 240 px navigation column,
 * a 64 px top bar, a flexible main area capped at 1440 px, and 920 px for
 * report reading. §3.4 sets the responsive behavior: full navigation at
 * ≥1200 px, collapsed below that, and a drawer under 768 px.
 *
 * This component renders the *frame* only. `OpsShell` and `ClientShell` supply
 * their own navigation and top-bar content, which is what keeps operator data
 * out of a client view (§10.1) rather than relying on a runtime check.
 */

export interface AppShellProps {
  sections: NavSection[];
  /** Top-bar start: the workspace name and any client/project selector. */
  topbarStart?: React.ReactNode;
  /** Top-bar end: account menu, messages, notifications. */
  topbarEnd?: React.ReactNode;
  /** Live counts for nav badges, keyed by `NavItem.badgeKey`. */
  badges?: Record<string, number>;
  /** Optional contextual panel. Becomes an overlay at <1200 px (§3.4). */
  detailPanel?: React.ReactNode;
  /** Reading-width content (920 px) for reports; otherwise 1440 px. */
  contentWidth?: 'content' | 'reading';
  brandHref: string;
  children: React.ReactNode;
}

export function AppShell({
  sections,
  topbarStart,
  topbarEnd,
  badges,
  detailPanel,
  contentWidth = 'content',
  brandHref,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  const nav = <NavColumn sections={sections} pathname={pathname} badges={badges} />;

  return (
    <div className="min-h-screen bg-canvas">
      {/*
        §3.4 — the detail panel is an overlay below 1200 px, where there is no
        room for a third column. Above that it is part of the layout.
      */}
      <div className="flex min-h-screen">
        {/* Fixed desktop navigation, hidden below the wide breakpoint. */}
        <aside className="hidden w-nav shrink-0 border-r border-border bg-surface min-[1200px]:block">
          <div className="sticky top-0 h-screen overflow-y-auto">
            <Link
              href={brandHref}
              className="flex h-topbar items-center border-b border-border px-5 text-subsection font-semibold tracking-tight"
            >
              Cailyx
            </Link>
            {nav}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-topbar items-center gap-3 border-b border-border bg-surface px-4">
            {/* Drawer trigger — the only navigation affordance below 1200 px. */}
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-[1200px]:hidden"
                  aria-label="Open navigation"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-nav p-0">
                <SheetTitle className="flex h-topbar items-center border-b border-border px-5 text-subsection font-semibold">
                  Cailyx
                </SheetTitle>
                {nav}
              </SheetContent>
            </Sheet>

            <div className="flex min-w-0 flex-1 items-center gap-2">{topbarStart}</div>
            <div className="flex shrink-0 items-center gap-1">{topbarEnd}</div>
          </header>

          <div className="flex min-w-0 flex-1">
            <main
              id="main"
              className={cn(
                'mx-auto w-full flex-1 px-4 py-6 sm:px-6',
                contentWidth === 'reading' ? 'max-w-reading' : 'max-w-content',
              )}
            >
              {children}
            </main>

            {/* Contextual evidence/detail panel — §3.2 page anatomy. */}
            {detailPanel ? (
              <aside className="hidden w-96 shrink-0 border-l border-border bg-surface min-[1200px]:block">
                <div className="sticky top-topbar max-h-[calc(100vh-var(--topbar))] overflow-y-auto p-4">
                  {detailPanel}
                </div>
              </aside>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavColumn({
  sections,
  pathname,
  badges,
}: {
  sections: NavSection[];
  pathname: string;
  badges?: Record<string, number>;
}) {
  return (
    <nav aria-label="Primary" className="px-3 py-4">
      {sections.map((section, index) => (
        <div key={section.label ?? `section-${index}`} className={index > 0 ? 'mt-6' : undefined}>
          {section.label ? (
            <h2 className="px-2 pb-2 text-meta font-medium uppercase tracking-wide text-muted-foreground">
              {section.label}
            </h2>
          ) : null}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActiveHref(pathname, item.href);
              const count = item.badgeKey ? badges?.[item.badgeKey] : undefined;
              const Icon = item.icon;

              if (item.unavailable) {
                // §3.5 — say the capability is absent rather than linking into
                // a dead page or quietly omitting it.
                return (
                  <li key={item.href}>
                    <span
                      aria-disabled="true"
                      title={item.unavailableReason ?? 'Not available yet'}
                      className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2 py-1.5 text-table text-muted-foreground/60"
                    >
                      {Icon ? <Icon aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
                      <span className="truncate">{item.label}</span>
                      <span className="ml-auto text-meta">Soon</span>
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-table transition-colors',
                      active
                        ? 'bg-primary-subtle font-medium text-primary'
                        : 'text-foreground hover:bg-surface-sunken',
                    )}
                  >
                    {Icon ? <Icon aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
                    <span className="truncate">{item.label}</span>
                    {typeof count === 'number' && count > 0 ? (
                      <span
                        className={cn(
                          'ml-auto rounded-full px-1.5 py-0.5 text-meta font-medium tabular-nums',
                          active ? 'bg-primary text-primary-foreground' : 'bg-surface-sunken',
                        )}
                      >
                        {count}
                        <span className="sr-only">{` ${item.label.toLowerCase()} items`}</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
