'use client';

import {
  FilePlus2,
  ShieldCheck,
  ClipboardList,
  MessageSquare,
  FileClock,
  FileX2,
  FolderPlus,
  LineChart,
  Link2Off,
  Ruler,
  Search,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * §3.5 EmptyState — the named empty variants, as distinct cases rather than
 * one generic blank slate.
 *
 * The contract that shapes this file: **copy is fixed per variant, not passed
 * in.** §3.5 gives each empty state its own required sentence, and two of them
 * are traps a generic component cannot protect against:
 *
 *  - "No reports" has *two* copies depending on whether a run exists. Saying
 *    "Your first report is being prepared" when nothing has ever been run is a
 *    false promise, so `runExists` is a required prop of that variant and the
 *    caller cannot render it without answering the question.
 *  - "Source never measured" must never become a zero or a fail, so the
 *    `not-measured` variant uses the `unmeasured` token and always offers the
 *    outstanding prerequisite.
 *
 * A `variant` prop plus a discriminated union means a screen physically cannot
 * invent its own empty-state wording, but it can still add specifics through
 * `children`.
 */

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

interface BaseProps {
  /** Extra context beneath the fixed copy — a run id, a project name, a
   *  timestamp. Supplementary only: the mandated sentence stays visible. */
  children?: React.ReactNode;
  className?: string;
  /** `panel` fills a card/section; `inline` is for a table body or a nested
   *  widget. */
  layout?: 'panel' | 'inline';
}

/**
 * The §3.5 empty variants. Required props are enforced per case so the two
 * "it depends" states (no-projects, no-reports) cannot be rendered without the
 * fact that decides their wording.
 */
export type EmptyStateProps = BaseProps &
  (
    | {
        /** No projects yet. §3.5: operator sees "Add project", client sees
         *  "Contact your lead" — different actors create the record. */
        variant: 'no-projects';
        audience: 'operator' | 'client';
        /** Operator only: the create-project handler. Ignored for a client. */
        onCreate?: () => void;
      }
    | {
        /** No reports yet. §3.5: the copy depends entirely on whether a run
         *  exists, so the caller must say which. */
        variant: 'no-reports';
        runExists: boolean;
        action?: EmptyStateAction;
      }
    | {
        /** Never measured. §3.5: "Not measured yet", with the outstanding
         *  prerequisite — never a zero-score pass/fail claim. */
        variant: 'not-measured';
        /** What is not measured, e.g. "AI answer visibility". */
        subject: string;
        /** What has to happen first, e.g. "Connect Search Console". */
        prerequisite?: string;
        action?: EmptyStateAction;
      }
    | {
        /** §3.5: "First measurement — a comparison will appear after a
         *  comparable run". */
        variant: 'no-comparison-baseline';
        action?: EmptyStateAction;
      }
    | {
        /** §3.5: explain the restricted action and the permitted path. */
        variant: 'insufficient-role';
        /** Verb phrase, e.g. "approve this article". */
        restrictedAction: string;
        /** What the person can do instead. */
        permittedPath?: string;
      }
    | {
        /** §3.5: OAuth connected but no resource chosen for this project. */
        variant: 'source-unmapped';
        /** The integration awaiting a choice, e.g. "Google Search Console". */
        sourceName: string;
        action: EmptyStateAction;
      }
    | {
        /** A filtered list returned nothing. Distinct from "no data exists" —
         *  offering "create one" here is how a screen tells a user their
         *  filter is empty when their account is empty. */
        variant: 'no-results';
        onClearFilters?: () => void;
      }
    | {
        /** An empty conversation thread. The copy differs by which side is
         *  reading it: an operator starting a thread is opening a
         *  relationship, a client staring at a blank thread is wondering
         *  whether anyone is there. */
        variant: 'no-messages';
        viewer: 'operator' | 'client';
      }
    | {
        /** A work list with nothing in it. Distinct from `no-results`: this
         *  list is not filtered, it is genuinely empty, and telling the reader
         *  to "clear the filters" would send them looking for a control that
         *  is not there. */
        variant: 'no-work';
        /** Whose work list this is, which decides the copy. */
        scope: 'mine' | 'project';
      }
    | {
        /**
         * An alert feed with nothing in it. Its own variant because the three
         * neighbouring ones are all wrong here: `no-results` claims a filter
         * is applied (it is not), `not-measured` implies no check has run
         * (one may have — it simply found nothing), and `no-work` is about
         * committed cycles.
         *
         * `hasChecked` separates "we looked and found nothing" from "nothing
         * has ever been checked", which are different reassurances.
         */
        variant: 'no-alerts';
        hasChecked: boolean;
      }
    | {
        /**
         * A record list where nothing has been created yet — an empty asset
         * library, an empty data-asset ledger, an empty campaign list.
         *
         * Distinct from `not-measured`, which is about a *measurement* that has
         * not been taken. Nothing here was supposed to be measured; the user
         * simply has not made anything yet, and the copy should say so without
         * implying a missing source.
         */
        variant: 'no-records';
        /** What is empty, lower case, e.g. "content assets", "data assets". */
        subject: string;
        /** The action that creates the first one, when there is one. */
        action?: EmptyStateAction;
      }
  );

interface VariantContent {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Extra class on the icon badge; `not-measured` uses the `unmeasured`
   *  token because a missing observation is not a failure. */
  iconClass: string;
  action?: EmptyStateAction;
}

const NEUTRAL_ICON = 'bg-surface-sunken text-muted-foreground';

function contentFor(props: EmptyStateProps): VariantContent {
  switch (props.variant) {
    case 'no-projects':
      return props.audience === 'operator'
        ? {
            icon: FolderPlus,
            title: 'No projects yet',
            body: 'A project is where a client’s domain, market and measurements live. Add the first one to start collecting evidence.',
            iconClass: 'bg-primary-subtle text-primary',
            action: props.onCreate
              ? { label: 'Add project', onClick: props.onCreate }
              : undefined,
          }
        : {
            icon: FolderPlus,
            title: 'No projects yet',
            body: 'Your delivery lead creates projects and connects them to your domain. Contact your lead to get started — there is nothing for you to set up here.',
            iconClass: NEUTRAL_ICON,
          };
    case 'no-reports':
      return props.runExists
        ? {
            icon: FileClock,
            title: 'Your first report is being prepared',
            body: 'We have started measuring this project. Your report appears here when it is ready — you do not need to do anything.',
            iconClass: 'bg-info-subtle text-info',
            action: props.action,
          }
        : {
            icon: FileX2,
            title: 'No report has been created',
            body: 'Reports are produced by a measurement check. Nothing has been measured for this project yet.',
            iconClass: NEUTRAL_ICON,
            action: props.action,
          };
    case 'not-measured':
      return {
        icon: Ruler,
        title: 'Not measured yet',
        body: `No measurement of ${props.subject} has been recorded, so there is no score, trend or comparison to show.${
          props.prerequisite ? ` First: ${props.prerequisite}.` : ''
        }`,
        // Deliberately `unmeasured`, never `danger`: an unmeasured value is a
        // missing observation, not a failed result (§3.3 contract).
        iconClass: 'bg-unmeasured-subtle text-unmeasured-foreground',
        action: props.action,
      };
    case 'no-comparison-baseline':
      return {
        icon: LineChart,
        title: 'First measurement',
        body: 'A comparison will appear after a similar period is measured — same metric, same method, same unit. Until then this is a single measurement, not a trend.',
        iconClass: NEUTRAL_ICON,
        action: props.action,
      };
    case 'insufficient-role':
      return {
        icon: ShieldAlert,
        title: 'You do not have access to this',
        body: `You cannot ${props.restrictedAction} at your current access level. ${
          props.permittedPath ?? 'Ask your delivery lead if you need it.'
        }`,
        iconClass: 'bg-warning-subtle text-warning-foreground',
      };
    case 'source-unmapped':
      return {
        icon: Link2Off,
        // §4.3 keeps Google-property vocabulary inside account-connection steps.
title: 'Choose the website for this project',
        body: `${props.sourceName} is connected, but no website has been chosen for this project yet, so nothing can be measured from it.`,
        iconClass: 'bg-warning-subtle text-warning-foreground',
        action: props.action,
      };
    case 'no-records':
      return {
        icon: FilePlus2,
        title: `No ${props.subject} yet`,
        body: `Nothing has been created here. This list fills as work is added — an empty list here means none exists, not that any is missing or filtered out.`,
        iconClass: NEUTRAL_ICON,
        action: props.action,
      };
    case 'no-alerts':
      return props.hasChecked
        ? {
            icon: ShieldCheck,
            title: 'No open alerts',
            body: 'A monitoring check has completed and found nothing that needs attention. Alerts appear here when a tracked condition changes.',
            iconClass: 'bg-success-subtle text-success-foreground',
          }
        : {
            icon: ShieldCheck,
            title: 'Nothing has been checked yet',
            body: 'No monitoring check has completed for this project, so there is nothing to report either way. An empty feed here is not a clean bill of health.',
            iconClass: NEUTRAL_ICON,
          };
    case 'no-work':
      return props.scope === 'mine'
        ? {
            icon: ClipboardList,
            title: 'Nothing assigned to you',
            body: 'Work appears here once it is committed to a work period and assigned. If you expected something, check with the delivery lead who owns the plan.',
            iconClass: NEUTRAL_ICON,
          }
        : {
            icon: ClipboardList,
            title: 'No work items yet',
            body: 'Work items come from agreed work periods. Once a work period is agreed, its deliverables appear here with an owner and a due date.',
            iconClass: NEUTRAL_ICON,
          };
    case 'no-messages':
      return props.viewer === 'operator'
        ? {
            icon: MessageSquare,
            title: 'No messages yet',
            body: 'This is the shared thread with the client. Messages here are visible to them, so use it for decisions and status rather than internal notes.',
            iconClass: NEUTRAL_ICON,
          }
        : {
            icon: MessageSquare,
            title: 'No messages yet',
            body: 'Your delivery team will post updates here. You can start the thread any time — replies come back to this page.',
            iconClass: NEUTRAL_ICON,
          };
    case 'no-results':
      return {
        icon: Search,
        title: 'No results match these filters',
        body: 'This list is filtered. Clear the filters to see everything in the current scope.',
        iconClass: NEUTRAL_ICON,
        action: props.onClearFilters
          ? { label: 'Clear filters', onClick: props.onClearFilters }
          : undefined,
      };
  }
}

/**
 * Renders the §3.5 empty state named by `variant`, with that variant's required
 * copy. The only free text a caller supplies is `children` (extra context) and
 * the names/verbs the variant asks for as required props.
 */
export function EmptyState(props: EmptyStateProps) {
  const { className, layout = 'panel' } = props;
  const { icon: Icon, title, body, iconClass, action } = contentFor(props);

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface',
        layout === 'panel' ? 'flex flex-col items-center gap-3 p-8 text-center' : 'p-6',
        className,
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          iconClass,
          layout === 'inline' && 'h-8 w-8',
        )}
      >
        <Icon aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className={cn('space-y-1', layout === 'panel' ? 'max-w-reading' : 'max-w-prose')}>
        <h3 className="text-subsection font-semibold text-foreground">{title}</h3>
        <p className="text-table text-muted-foreground">{body}</p>
        {props.children && <div className="pt-1 text-table text-foreground">{props.children}</div>}
      </div>
      {action && (
        <div className="pt-1">
          {action.href ? (
            <Button asChild variant="outline" size="sm">
              <a href={action.href}>{action.label}</a>
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
