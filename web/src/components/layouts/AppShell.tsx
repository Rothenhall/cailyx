'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { isActiveHref, sectionContainsPath, type NavItem, type NavSection } from '@/lib/navigation';

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
  /**
   * Namespace for remembered navigation state (currently the collapsed
   * state of §3.2's Team tools group). The shells pass the signed-in user's
   * id, which is what makes the preference per user. Absent means the section
   * defaults are used and nothing is written.
   */
  navScope?: string;
  children: React.ReactNode;
}

/**
 * The wordmark plus its parent credit.
 *
 * Rothenhall brand kit v1.1.0, identity rule: "Cailyx never appears without
 * Rothenhall in the same view, at minimum in the footer." The nav column is
 * present in every signed-in view, so it carries the attribution rather than
 * asking each page for a footer. Naming follows the kit: Cailyx with a capital
 * C and no article, Rothenhall one word with capitals R and H.
 */
function Wordmark({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="flex h-topbar flex-col justify-center gap-0.5 border-b border-border px-5"
    >
      <span className="text-subsection font-semibold tracking-tight">Cailyx</span>
      <span className="text-meta font-normal text-muted-foreground">
        A Rothenhall product
      </span>
    </Link>
  );
}

export function AppShell({
  sections,
  topbarStart,
  topbarEnd,
  badges,
  detailPanel,
  contentWidth = 'content',
  brandHref,
  navScope,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  const nav = (
    <NavColumn sections={sections} pathname={pathname} badges={badges} navScope={navScope} />
  );

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
            <Wordmark href={brandHref} />
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
                {/* Same identity rule as the desktop wordmark: the drawer is a
                    view where Cailyx appears on its own. */}
                <p className="border-b border-border px-5 py-2 text-meta text-muted-foreground">
                  A Rothenhall product
                </p>
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

/**
 * Remembers which collapsible sections are closed, per user.
 *
 * There is no server-side preference store in this app, so this is the
 * browser's own storage — §3.2's "remember its state per user" is satisfied by
 * keying on the signed-in user's id, which the shells supply as `navScope`.
 * Every access is wrapped: storage throws in a private window and is cleared
 * without warning, and a navigation column must not be the thing that breaks a
 * page when that happens. A missing or unreadable value falls back to the
 * section's declared default, which is what a first-time user should see.
 */
const NAV_PREF_PREFIX = 'cailyx:nav:';

function sectionKey(section: NavSection, index: number): string {
  return section.persistKey ?? section.label ?? `section-${index}`;
}

function readNavPrefs(scope: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(`${NAV_PREF_PREFIX}${scope}`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

function writeNavPrefs(scope: string, value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(`${NAV_PREF_PREFIX}${scope}`, JSON.stringify(value));
  } catch {
    // Storage unavailable or full — the navigation still works, the preference
    // just does not survive the session.
  }
}

interface CollapseState {
  collapsed: Record<string, boolean>;
  toggle: (key: string) => void;
}

function useCollapsedSections(sections: NavSection[], navScope: string | undefined): CollapseState {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      sections
        .filter((section) => section.collapsible)
        .map((section, index) => [sectionKey(section, index), section.defaultCollapsed ?? false]),
    ),
  );

  // Read the remembered state after mount rather than during render: the server
  // has no localStorage, and reading it during render would desynchronise the
  // first client render from the HTML it is hydrating.
  useEffect(() => {
    if (!navScope) return;
    const stored = readNavPrefs(navScope);
    if (Object.keys(stored).length === 0) return;
    setCollapsed((current) => ({ ...current, ...stored }));
  }, [navScope]);

  const toggle = useCallback(
    (key: string) => {
      setCollapsed((current) => {
        const next = { ...current, [key]: !current[key] };
        if (navScope) writeNavPrefs(navScope, next);
        return next;
      });
    },
    [navScope],
  );

  return { collapsed, toggle };
}

function NavColumn({
  sections,
  pathname,
  badges,
  navScope,
}: {
  sections: NavSection[];
  pathname: string;
  badges?: Record<string, number>;
  navScope?: string;
}) {
  const { collapsed, toggle } = useCollapsedSections(sections, navScope);
  // §3.2 — a collapsed section still has to show where the reader is, so an
  // active child route forces it open. Once the reader toggles it themselves in
  // this session, their choice wins outright; otherwise the toggle would look
  // broken on exactly the pages where it matters.
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  return (
    <nav aria-label="Primary" className="px-3 py-4">
      {sections.map((section, index) => {
        const key = sectionKey(section, index);
        const isCollapsible = Boolean(section.collapsible);
        const containsActive = isCollapsible && sectionContainsPath(section, pathname);
        const expanded = !isCollapsible || !collapsed[key] || (!touched[key] && containsActive);
        const panelId = `nav-section-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const primary = section.items.filter((item) => !item.secondary);
        const secondary = section.items.filter((item) => item.secondary);

        return (
          <div
            key={key}
            className={cn(index > 0 && 'mt-6', isCollapsible && 'rounded-md')}
          >
            {section.label ? (
              isCollapsible ? (
                <button
                  type="button"
                  onClick={() => {
                    setTouched((current) => ({ ...current, [key]: true }));
                    toggle(key);
                  }}
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  className={cn(
                    'flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-meta font-medium uppercase tracking-wide',
                    'text-muted-foreground transition-colors hover:bg-surface-sunken hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                    containsActive && !expanded && 'text-foreground',
                  )}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform',
                      expanded && 'rotate-90',
                    )}
                  />
                  <span className="truncate">{section.label}</span>
                  {containsActive && !expanded ? (
                    <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  ) : null}
                </button>
              ) : (
                <h2 className="px-2 pb-2 text-meta font-medium uppercase tracking-wide text-muted-foreground">
                  {section.label}
                </h2>
              )
            ) : null}

            {expanded ? (
              <div id={panelId}>
                <ul className="space-y-0.5">
                  {primary.map((item) => (
                    <NavListItem
                      key={item.href}
                      item={item}
                      pathname={pathname}
                      count={item.badgeKey ? badges?.[item.badgeKey] : undefined}
                    />
                  ))}
                  {secondary.length > 0 ? (
                    <li className="pt-1">
                      <span className="sr-only">Secondary links</span>
                      <span aria-hidden="true" className="block border-t border-border" />
                    </li>
                  ) : null}
                  {secondary.map((item) => (
                    <NavListItem
                      key={item.href}
                      item={item}
                      pathname={pathname}
                      count={item.badgeKey ? badges?.[item.badgeKey] : undefined}
                    />
                  ))}
                </ul>

                {/*
                  §3.2 / §22 D05–D09 — the staff-only headings. They are part of
                  the Team tools panel rather than a section of their own so the
                  daily tree stays the length §3.2 asks for; the heading text
                  plus its note states the boundary in the UI instead of leaving
                  it implied by nesting.
                */}
                {(section.groups ?? []).map((group) => (
                  <div key={group.label} className="mt-3">
                    <h3
                      id={`${panelId}-${group.label.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                      className="px-2 pb-1 text-meta font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {group.label}
                    </h3>
                    {group.note ? (
                      <p className="px-2 pb-1 text-meta text-muted-foreground">{group.note}</p>
                    ) : null}
                    <ul
                      aria-labelledby={`${panelId}-${group.label.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                      className="space-y-0.5"
                    >
                      {group.items.map((item) => (
                        <NavListItem
                          key={item.href}
                          item={item}
                          pathname={pathname}
                          count={item.badgeKey ? badges?.[item.badgeKey] : undefined}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

function NavListItem({
  item,
  pathname,
  count,
}: {
  item: NavItem;
  pathname: string;
  count?: number;
}) {
  const active = isActiveHref(pathname, item.href);
  const Icon = item.icon;

  if (item.unavailable) {
    // §3.5 — say the capability is absent rather than linking into a dead page
    // or quietly omitting it.
    return (
      <li>
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
    <li>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-table transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          active
            ? 'bg-primary-subtle font-medium text-primary'
            : item.secondary
              ? 'text-muted-foreground hover:bg-surface-sunken hover:text-foreground'
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
}
