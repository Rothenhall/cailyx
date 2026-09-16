'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CLIENT_NAV, CLIENT_PROJECT_NAV, clientProjectNavHref } from '@/lib/navigation';
import { useSession } from '@/hooks/useSession';
import { AppShell } from './AppShell';
import { AccountMenu } from './OpsShell';

/**
 * The client portal shell — design_plan.md §2.3 "Client portal".
 *
 * The hard rule this component exists to honor: **"Client navigation never
 * contains an all-clients selector."** `CLIENT_NAV` has no such entry, and
 * nothing here adds one — the client sees only their own projects.
 *
 * §10.1 is explicit that route groups alone are not authorization, so this
 * shell is presentation only. Every read it triggers is scoped by the backend
 * from the JWT; the shell cannot widen access by hiding or showing a link.
 *
 * §2.3 also says one-project clients should land in that project's home rather
 * than a portfolio. That redirect belongs in the client home page, which knows
 * how many projects the client actually has — a shell cannot know that without
 * fetching, and fetching on every route would be wasteful.
 */

export interface ClientShellProps {
  badges?: Record<string, number>;
  detailPanel?: React.ReactNode;
  contentWidth?: 'content' | 'reading';
  children: React.ReactNode;
}

function clientProjectPrefix(pathname: string): string | null {
  const match = /^\/client\/projects\/([^/]+)/.exec(pathname);
  return match ? match[1] : null;
}

export function ClientShell({ badges, detailPanel, contentWidth, children }: ClientShellProps) {
  const pathname = usePathname();
  const { user, status, signOut } = useSession();
  const projectId = clientProjectPrefix(pathname);

  const sections = projectId
    ? CLIENT_PROJECT_NAV.map((section) => ({
        ...section,
        items: section.items.map((item) => ({
          ...item,
          href: clientProjectNavHref(projectId, item.href),
        })),
      }))
    : CLIENT_NAV;

  return (
    <AppShell
      brandHref="/client"
      sections={sections}
      badges={badges}
      detailPanel={detailPanel}
      contentWidth={contentWidth}
      topbarStart={
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-table">
          <Link
            href="/client"
            className="truncate text-muted-foreground transition-colors hover:text-foreground"
          >
            Your workspace
          </Link>
          {projectId ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                /
              </span>
              <span className="truncate font-medium">Project</span>
            </>
          ) : null}
        </nav>
      }
      topbarEnd={
        <div className="flex items-center gap-1">
          <Link
            href="/client/messages"
            className="rounded-md px-2 py-1.5 text-table text-muted-foreground transition-colors hover:bg-surface-sunken hover:text-foreground"
          >
            Messages
          </Link>
          <AccountMenu
            status={status}
            name={user?.name}
            email={user?.email}
            onSignOut={signOut}
          />
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
