'use client';

import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

/**
 * §3.2 PageHeader — the top of every working page:
 * breadcrumb → title/context → **one** primary action → summary/status.
 *
 * The single-primary-action rule is enforced by the API rather than by
 * convention: there is exactly one `primaryAction` prop, and everything else
 * goes in the `secondaryActions` slot. A screen cannot accidentally render two
 * filled blue buttons and leave the reader to guess which one is the action.
 */

export interface PageHeaderBreadcrumb {
  label: string;
  /** Omit on the final crumb — it renders as the current page. */
  href?: string;
}

export interface PageHeaderAction {
  label: string;
  /** Names the action concretely ("Start SEO audit"), not "Go" — §3.2 and
   *  §10.4 both require the action to be self-describing. */
  onClick?: () => void;
  /** Renders the action as a link instead of a button. */
  href?: string;
  disabled?: boolean;
  /** Why the action is disabled. Rendered as a `title` and announced via
   *  `aria-describedby`; a disabled action with no reason is a dead end. */
  disabledReason?: string;
  icon?: ReactNode;
  /** Marks a destructive primary action (delete is never a primary action in
   *  §3.2's portfolio pattern, but a dialog's confirm can reuse this shape). */
  destructive?: boolean;
}

export interface PageHeaderProps {
  /** Renders nothing when empty — a page with no parent is not given a fake
   *  crumb to fill the slot. */
  breadcrumbs?: PageHeaderBreadcrumb[];
  title: string;
  /** One line of context under the title: owner, cycle, domain, market. */
  context?: ReactNode;
  /** Status/summary chips — a `StatusPill`, a `ProvenanceBadge`, a run date. */
  status?: ReactNode;
  /** THE primary action. Exactly one per page. */
  primaryAction?: PageHeaderAction;
  /** Secondary actions — outline/ghost buttons, a row menu. A separate slot
   *  so they can never be styled as the primary. */
  secondaryActions?: ReactNode;
  /** Heading level for the title. Defaults to `h1`. */
  headingLevel?: 'h1' | 'h2';
  className?: string;
}

/**
 * The standard page header. Keep the primary action to one: if a page seems to
 * need two, the second belongs in `secondaryActions` or in the page body.
 */
export function PageHeader({
  breadcrumbs,
  title,
  context,
  status,
  primaryAction,
  secondaryActions,
  headingLevel: Heading = 'h1',
  className,
}: PageHeaderProps) {
  const hasCrumbs = Boolean(breadcrumbs?.length);
  const reasonId = primaryAction?.disabledReason ? 'page-header-primary-reason' : undefined;

  return (
    <header className={cn('space-y-3', className)}>
      {hasCrumbs && (
        <Breadcrumb>
          <BreadcrumbList className="text-meta">
            {breadcrumbs?.map((crumb, index) => {
              const isLast = index === (breadcrumbs?.length ?? 0) - 1;
              return (
                <Fragment key={`${crumb.label}-${index}`}>
                  <BreadcrumbItem>
                    {isLast || !crumb.href ? (
                      <BreadcrumbPage className="text-meta text-muted-foreground">
                        {crumb.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild className="text-meta">
                        <Link href={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {!isLast && <BreadcrumbSeparator />}
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <Heading className="text-title font-semibold text-foreground">{title}</Heading>
          {context && <div className="text-table text-muted-foreground">{context}</div>}
        </div>

        {(primaryAction || secondaryActions) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {secondaryActions}
            {primaryAction &&
              (primaryAction.disabled ? (
                <span className="inline-flex flex-col items-end gap-1">
                  <Button
                    type="button"
                    variant={primaryAction.destructive ? 'destructive' : 'default'}
                    disabled
                    aria-describedby={reasonId}
                    title={primaryAction.disabledReason}
                  >
                    {primaryAction.icon}
                    {primaryAction.label}
                  </Button>
                  {primaryAction.disabledReason && (
                    <span id={reasonId} className="text-meta text-muted-foreground">
                      {primaryAction.disabledReason}
                    </span>
                  )}
                </span>
              ) : primaryAction.href ? (
                <Button
                  asChild
                  variant={primaryAction.destructive ? 'destructive' : 'default'}
                >
                  <Link href={primaryAction.href}>
                    {primaryAction.icon}
                    {primaryAction.label}
                  </Link>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant={primaryAction.destructive ? 'destructive' : 'default'}
                  onClick={primaryAction.onClick}
                >
                  {primaryAction.icon}
                  {primaryAction.label}
                </Button>
              ))}
          </div>
        )}
      </div>

      {status && <div className="flex flex-wrap items-center gap-2">{status}</div>}
    </header>
  );
}
