'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsUpDown, LogOut, UserCog } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/hooks/useSession';
import { OPERATOR_NAV, PROJECT_NAV, projectNavHref, visibleSections } from '@/lib/navigation';
import { AppShell } from './AppShell';

/**
 * The operator workspace shell — design_plan.md §2.3 "Operator workspace".
 *
 * The navigation switches from the portfolio tree to the within-project tree
 * based on the URL. That is deliberate: §2.3 puts project context in a distinct
 * branch, and keeping one shell means the operator never loses the top bar,
 * which is where the client/project selectors live.
 */

export interface OpsShellProps {
  badges?: Record<string, number>;
  detailPanel?: React.ReactNode;
  contentWidth?: 'content' | 'reading';
  children: React.ReactNode;
}

/** The `/projects/:id` prefix, or null when not inside a project. */
function projectPrefix(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(pathname);
  return match ? match[1] : null;
}

export function OpsShell({ badges, detailPanel, contentWidth, children }: OpsShellProps) {
  const pathname = usePathname();
  const { user, status, signOut } = useSession();
  const projectId = projectPrefix(pathname);

  const sections = projectId
    ? PROJECT_NAV.map((section) => ({
        ...section,
        items: section.items.map((item) => ({
          ...item,
          href: projectNavHref(projectId, item.href),
        })),
      }))
    : visibleSections(OPERATOR_NAV, user?.role);

  return (
    <AppShell
      brandHref="/ops"
      sections={sections}
      badges={badges}
      detailPanel={detailPanel}
      contentWidth={contentWidth}
      topbarStart={
        <div className="flex min-w-0 items-center gap-2">
          {projectId ? <ProjectBreadcrumb projectId={projectId} /> : <WorkspaceLabel />}
        </div>
      }
      topbarEnd={<AccountMenu status={status} name={user?.name} email={user?.email} onSignOut={signOut} />}
    >
      {children}
    </AppShell>
  );
}

function WorkspaceLabel() {
  return <span className="truncate text-table font-medium">Operator workspace</span>;
}

/**
 * Shows the project this page is scoped to.
 *
 * It reads the id from the URL rather than fetching the project, so the shell
 * adds no request to every page render. The page itself renders the real name;
 * this is a positional cue, not a data display.
 */
function ProjectBreadcrumb({ projectId }: { projectId: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-table">
      <Link
        href="/ops/projects"
        className="truncate text-muted-foreground transition-colors hover:text-foreground"
      >
        Projects
      </Link>
      <span aria-hidden="true" className="text-muted-foreground">
        /
      </span>
      <span className="truncate font-medium" title={projectId}>
        This project
      </span>
    </nav>
  );
}

export interface AccountMenuProps {
  status: 'loading' | 'authenticated' | 'anonymous';
  name?: string;
  email?: string;
  onSignOut: () => void | Promise<void>;
}

/**
 * The account menu.
 *
 * While the profile is loading it renders a skeleton rather than a sign-in
 * prompt: §3.5's "do not start a duplicate action" logic applies to
 * authentication too, and flashing a signed-out state during a refresh is how
 * a user ends up clicking a stale button.
 */
export function AccountMenu({ status, name, email, onSignOut }: AccountMenuProps) {
  if (status === 'loading') {
    return <Skeleton className="h-8 w-8 rounded-full" />;
  }

  if (status === 'anonymous') {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href="/sign-in">Sign in</Link>
      </Button>
    );
  }

  const initials = (name ?? email ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          aria-label={`Account menu for ${name ?? email ?? 'your account'}`}
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-meta">{initials}</AvatarFallback>
          </Avatar>
          <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-table font-medium">{name ?? 'Signed in'}</div>
          {email ? (
            <div className="truncate text-meta text-muted-foreground">{email}</div>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserCog aria-hidden="true" className="mr-2 h-4 w-4" />
            Account &amp; sessions
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void onSignOut()}>
          <LogOut aria-hidden="true" className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
