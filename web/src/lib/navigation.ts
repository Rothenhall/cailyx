import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Blocks,
  BookOpen,
  Briefcase,
  Building2,
  CalendarDays,
  CircleDollarSign,
  Compass,
  FileText,
  FlaskConical,
  Gauge,
  Globe,
  Layers,
  Lightbulb,
  Link2,
  ListChecks,
  MapPin,
  Megaphone,
  MessageSquare,
  Newspaper,
  PanelsTopLeft,
  PenLine,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Target,
  TrendingUp,
  UserCog,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { OperatorRole } from '@/services/types';

/**
 * The navigation model, as data.
 *
 * Two rules are encoded here rather than left to each shell:
 *
 *  - **"Client navigation never contains an all-clients selector."** The client
 *    tree below simply has no such entry; `ClientShell` renders from this list,
 *    so the rule holds by construction.
 *  - **"One-project clients land directly in that project's home context."**
 *    That is a routing decision, handled by the client shell's redirect, not by
 *    hiding a nav item.
 *
 * P16 (platform_improvement_plan.md §3.2–§3.4) reshaped the project tree from
 * the older, module-shaped grouping ("Plan & Work", "Research & Audits",
 * "Content" with eleven entries, "Authority") into the audience-shaped one
 * §3.2 specifies. The change is deliberately **structural, not subtractive**:
 * every destination the old tree offered is still in the tree, but the
 * staff-only research and evidence surfaces — which §22 D05–D09 keep pending a
 * product decision — moved into the collapsed Team tools group instead of
 * sharing the top level with the screens a nontechnical reader uses daily.
 * §4.3 is the reason: "Do not show backend-module groupings to clients", and
 * the same grouping was making the staff tree read like the backend's folder
 * layout.
 *
 * Items whose capability does not exist yet carry `unavailable: true`. They are
 * still listed — §3.5 wants the reader told what is not there — but render as a
 * disabled state with a reason rather than a link into a dead page. Every
 * `unavailable` flag here must be cleared the moment the backing screen ships.
 */

export interface NavItem {
  label: string;
  href: string;
  icon?: LucideIcon;
  /** Operator roles allowed to see this item. Absent means every operator. */
  roles?: OperatorRole[];
  /** Screens that are specified in §4 but not yet built. */
  unavailable?: boolean;
  /** Shown with the unavailable state — why it is not there yet. */
  unavailableReason?: string;
  /** Renders a live count badge; the shell supplies the number. */
  badgeKey?: 'approvals' | 'messages' | 'clientsNeedingAttention' | 'failedRuns';
  /**
   * The href is already absolute, so a project-scoped shell must not prefix it.
   * §3.2's "My work / team work" is the case this exists for: the work inbox is
   * a portfolio destination, not a project one.
   */
  absolute?: boolean;
  /**
   * §3.3 — a secondary destination. Rendered in a visually de-emphasised list
   * below the primary items rather than removed: Business information and
   * Connected accounts stay reachable, but they are setup screens, not the
   * client's daily path.
   */
  secondary?: boolean;
}

/**
 * A staff-only sub-heading inside a section — §3.2's Research tools and
 * Evidence tools headings.
 *
 * The staff-only boundary is structural, not a runtime check: these groups are
 * attached to `PROJECT_NAV` (see `resolveProjectNav`), and only `OpsShell`
 * renders that tree. `ClientShell` renders `CLIENT_PROJECT_NAV`, so no client
 * can reach these entries — the same "holds by construction" guarantee the
 * all-clients rule already relies on.
 */
export interface NavGroup {
  label: string;
  items: NavItem[];
  /** Rendered only for these roles. Absent means every operator. */
  roles?: OperatorRole[];
  /** Stated in the UI, so the boundary is not only implied by nesting. */
  note?: string;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
  /** Staff-only sub-headings rendered under this section's items (§3.2). */
  groups?: NavGroup[];
  /**
   * §3.2 — "Keep Team tools collapsed, remember its state per user."
   * A collapsible section renders as a toggle button plus a panel.
   */
  collapsible?: boolean;
  /** Start collapsed for a first-time user. */
  defaultCollapsed?: boolean;
  /**
   * localStorage key fragment for the remembered state. Combined with the
   * signed-in user's id by `AppShell`, which is what makes it *per user*.
   */
  persistKey?: string;
  /** Roles allowed to see the whole section. Absent means every operator. */
  roles?: OperatorRole[];
}

/** Operator workspace — portfolio scope (§3.4). */
export const OPERATOR_NAV: NavSection[] = [
  {
    items: [
      { label: 'Today', href: '/ops', icon: Gauge },
      { label: 'Clients', href: '/ops/clients', icon: Building2 },
      { label: 'My Work', href: '/ops/work', icon: ListChecks },
      // §3.4: "Rename the global calendar entry to **Content calendar** and
      // treat it as the portfolio scope of the same calendar." The route is
      // unchanged — the label is the part that was wrong, because "Calendar"
      // promised a business-wide calendar and the screen is the content
      // calendar across every project.
      { label: 'Content calendar', href: '/ops/calendar', icon: CalendarDays },
      { label: 'Reports', href: '/ops/reports', icon: FileText },
      {
        label: 'Sales',
        href: '/ops/sales',
        icon: Briefcase,
        roles: ['admin', 'delivery-lead', 'sales'],
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      // §3.4's admin names. The routes are unchanged; four labels were not
      // ("People", "Rubrics", "Budgets", "Activity"), and each wrong label was
      // the kind §4.3 exists to fix: "People" hid the access half of the
      // screen, "Rubrics" named the mechanism instead of the setting, and
      // "Budgets"/"Activity" were too vague to predict what they governed.
      { label: 'People and access', href: '/ops/admin/people', icon: UserCog, roles: ['admin'] },
      {
        label: 'Service connections',
        href: '/ops/admin/connections',
        icon: Blocks,
        roles: ['admin', 'delivery-lead'],
      },
      { label: 'Score settings', href: '/ops/admin/rubrics', icon: Target, roles: ['admin'] },
      {
        label: 'Spending limits',
        href: '/ops/admin/budgets',
        icon: CircleDollarSign,
        roles: ['admin'],
      },
      { label: 'Activity history', href: '/ops/admin/activity', icon: Activity, roles: ['admin'] },
      { label: 'Templates', href: '/ops/admin/templates', icon: Layers, roles: ['admin'] },
      { label: 'Organization', href: '/ops/admin/settings', icon: Settings, roles: ['admin'] },
    ],
  },
];

/**
 * §3.2's staff-only headings, as data.
 *
 * §22 D05–D09 keep every route listed here present and un-redesigned until the
 * product decision lands; only its grouping changed, from top-level research
 * entries to sub-headings of the collapsed Team tools group. Nothing was
 * deleted, and no route was moved to a different owner.
 */
const STAFF_GROUPS: NavGroup[] = [
  {
    label: 'Research tools',
    note: 'Staff only. Definitions pending (§22 D05–D08).',
    items: [
      { label: 'Improvement priorities', href: '/priorities', icon: Target },
      { label: 'Brand details', href: '/research/entities', icon: Tag },
      { label: 'Target locations', href: '/research/markets', icon: MapPin },
      { label: 'Keywords', href: '/research/keywords', icon: TrendingUp },
      { label: 'Search trackers', href: '/research/serp', icon: Search },
      { label: 'Buyer research', href: '/research/journeys', icon: Compass },
      { label: 'Research campaigns', href: '/research/campaigns', icon: FlaskConical },
      { label: 'Research and data', href: '/content/data-assets', icon: BarChart3 },
    ],
  },
  {
    label: 'Evidence tools',
    note: 'Staff only. Definitions pending (§22 D09).',
    items: [{ label: 'Claims', href: '/claims', icon: ShieldCheck }],
  },
];

/**
 * Within a project — §3.2 "Recommended staff project navigation".
 *
 * `href` values are relative to `/projects/:projectId` unless the item sets
 * `absolute: true`; `resolveProjectNav` prefixes them so a screen never
 * hand-builds a project URL.
 *
 * The order is §3.2's, and it is an audience order rather than a backend-module
 * order: the things a delivery lead opens every day, then the two groups, then
 * the three shared destinations, then the collapsed staff toolbox, then
 * settings.
 */
export const PROJECT_NAV: NavSection[] = [
  {
    items: [
      { label: 'Overview', href: '', icon: PanelsTopLeft },
      // §3.2 "Plan". The route is `/roadmap`, and the label is the visible half
      // of §4.3's "Roadmap → 30-day plan": the screen has carried the 30-day
      // plan's commitments since P11, and its own title now agrees (§6.2:
      // "30-day plan" for staff).
      { label: 'Plan', href: '/roadmap', icon: Workflow },
      // §6.4: one content calendar. P10 rebuilt this route as the real one
      // (placements, publications, the shared ContentCalendar component) and
      // dropped work-item due dates and cadence runs from it — those are on
      // Team work and Monitoring, which is where a task deadline belongs.
      { label: 'Content calendar', href: '/calendar', icon: CalendarDays },
    ],
  },
  {
    // §3.2 "Performance". The former "Research & Audits" heading is gone: §4.3
    // maps it to "Performance" precisely so the reader is not shown the shape
    // of the backend's modules.
    label: 'Performance',
    items: [
      // P12 (§7.1, R09) collapsed the three-way "Website health" / "Search
      // performance" / "Traffic & acquisition" split into ONE destination.
      // Health, Google search and visitors are three views of the same
      // question and were only ever separated by which API produced them. Both
      // retired routes still resolve — they redirect into this screen's
      // matching view — so no bookmark breaks.
      { label: 'Website', href: '/research/website', icon: Wrench },
      // P13 (§8.1) merged the former AI-visibility hub and the prompt library
      // into one destination with three views. The old /research/prompts route
      // redirects here.
      { label: 'AI visibility', href: '/research/ai', icon: Sparkles },
      // P05 (§11.1, R18/R19) — one unified screen replaces the former "Digital
      // footprint" / "Presence insights" split. The insights route still
      // resolves (it redirects here) so no bookmark or deep link breaks.
      { label: 'Online presence', href: '/research/presence', icon: Globe },
      { label: 'Competitors', href: '/research/competitors', icon: Users },
    ],
  },
  {
    // §3.2 "Content": one workspace, plus writing style as the secondary
    // destination §13.1 allows. The ideas, in-progress, needs-review,
    // scheduled and published views are tabs of `/content` — §3.2: "views of
    // one workspace, not new sidebars with competing object lists" — so they
    // are deliberately NOT separate entries here.
    label: 'Content',
    items: [
      { label: 'All content', href: '/content', icon: Newspaper },
      { label: 'Writing style', href: '/content/writing-style', icon: PenLine },
      // §4.3 "Refresh / sleeper → Update existing content". This is the
      // page-level update analysis (which live pages are worth improving),
      // which the workspace's `updating` view does not carry.
      {
        label: 'Update existing content',
        href: '/content/refreshes',
        icon: RefreshCw,
        secondary: true,
      },
      // §12.5's "The canonical list lives in Content → Ideas" is the Ideas tab
      // of `/content`; this screen is the analysis and management workspace
      // behind it (run the gap analysis, dismiss an idea, reopen one). It stays
      // reachable — the content workspace links here from its Ideas view and
      // from any piece promoted out of an idea — but it is not a second object
      // list in the primary navigation, which is the duplication §3.2 rules out.
      {
        label: 'Ideas workspace',
        href: '/content/opportunities',
        icon: Lightbulb,
        secondary: true,
      },
    ],
  },
  {
    // §3.2 puts these three between the Content group and Team tools: the
    // shared foundation (§9.1), the reports a client is actually shown, and the
    // account connections everything else depends on.
    items: [
      { label: 'Reports', href: '/reports', icon: FileText },
      // design_plan.md §9.1: "Move Site Context to Business information outside
      // Research/Performance" (P02, R13). §3.2 keeps it at the top level
      // because §9.1 calls it "the shared foundation" every other screen reads
      // from — not one research artifact among many.
      { label: 'Business information', href: '/business-info', icon: BookOpen },
      // §4.3: "Integration → Connected account". "Connections" named the
      // mechanism; the screen is about the accounts, and the client portal
      // already says "Connected accounts".
      { label: 'Connected accounts', href: '/connections', icon: Blocks },
    ],
  },
  {
    label: 'Team tools',
    collapsible: true,
    defaultCollapsed: true,
    persistKey: 'team-tools',
    items: [
      // §3.2 "My work / team work". The work inbox is the global one that §5.6
      // and §3.2 point at — "put 'Needs your action' in Overview and the global
      // work inbox rather than introducing another overlapping primary
      // navigation label" — so this is an absolute href, not a project route,
      // and there is no duplicate "Needs your action" nav entry anywhere.
      { label: 'My work / team work', href: '/ops/work', icon: ListChecks, absolute: true },
      { label: 'Delivery cycles', href: '/cycles', icon: Layers },
      // §3.2 "Review queue". The screen's own title is "Editorial reviews"; the
      // nav says what the queue is for, per §15.2's "do not let the same UI
      // button blur authoring, internal quality review, client approval, and
      // publishing".
      { label: 'Review queue', href: '/content/reviews', icon: ShieldCheck },
      { label: 'Monitoring and schedules', href: '/monitoring', icon: AlertTriangle },
      { label: 'Authority and outreach', href: '/authority/opportunities', icon: Megaphone },
      { label: 'Outreach campaigns', href: '/authority/campaigns', icon: Send },
      { label: 'Backlinks', href: '/authority/backlinks', icon: Link2 },
      { label: 'Mention health', href: '/authority/mentions', icon: ShieldCheck },
    ],
  },
  {
    items: [{ label: 'Project settings', href: '/settings', icon: Settings }],
  },
];

/** Builds an absolute project-scoped href from a `PROJECT_NAV` entry. */
export function projectNavHref(projectId: string, href: string): string {
  return `/projects/${projectId}${href}`;
}

/**
 * Resolves one nav item against the shel's scope. `absolute` items pass through
 * untouched; everything else is prefixed. Keeping this in one place is what
 * stops a shell from hand-building a project URL and getting it wrong.
 */
export function resolveNavHref(
  item: Pick<NavItem, 'href' | 'absolute'>,
  prefix: (href: string) => string,
): string {
  return item.absolute ? item.href : prefix(item.href);
}

/**
 * The resolved project tree for one project: relative hrefs prefixed, the
 * staff-only groups attached to Team tools, and role filtering applied.
 *
 * It lives here rather than inline in `OpsShell` so the tree is assertable from
 * source (see `backend/smoke/nav-rollout.smoke.sh`) — a structure that is only
 * correct after a React render is one no check can protect.
 */
export function resolveProjectNav(
  projectId: string,
  role: OperatorRole | undefined,
): NavSection[] {
  const prefix = (href: string) => projectNavHref(projectId, href);
  const scoped = PROJECT_NAV.map((section) => ({
    ...section,
    groups: section.label === 'Team tools' ? STAFF_GROUPS : section.groups,
    items: section.items.map((item) => ({ ...item, href: resolveNavHref(item, prefix) })),
  })).map((section) => ({
    ...section,
    groups: section.groups?.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, href: resolveNavHref(item, prefix) })),
    })),
  }));

  return visibleSections(scoped, role);
}

/**
 * Client portal — §3.3.
 *
 * Note what is absent: there is no client selector, no other-client surface,
 * and no operator tool. That absence is the point.
 */
export const CLIENT_NAV: NavSection[] = [
  {
    items: [
      { label: 'Home', href: '/client', icon: PanelsTopLeft },
      {
        label: 'Approvals',
        href: '/client/approvals',
        icon: ShieldCheck,
        badgeKey: 'approvals',
      },
      { label: 'Reports', href: '/client/reports', icon: FileText },
      { label: 'Messages', href: '/client/messages', icon: MessageSquare, badgeKey: 'messages' },
      { label: 'Account', href: '/client/account', icon: UserCog },
    ],
  },
];

/**
 * Within one of the client's own projects — §3.3.
 *
 * §3.3 fixes the primary row at five items ("Overview | Plan | Results |
 * Content | Calendar") and explicitly demotes Business information and
 * Connected accounts to *secondary links*. They were primary here before P16,
 * which put two setup screens on the same footing as the client's daily path.
 * §3.3 also says Business information stays reachable from the overview's setup
 * checklist, so demoting them costs the client nothing.
 *
 * §3.3's absolute rules, all of which hold by construction in this file:
 *  - no all-client selector anywhere in the client tree (there is no such
 *    entry, and `ClientShell` renders only from these lists);
 *  - one-project clients land directly in their project (the `/client` home
 *    redirect, not a nav concern);
 *  - clients never see the staff Research or Evidence tools — those live in
 *    `PROJECT_NAV` / `STAFF_GROUPS`, which only `OpsShell` reads.
 */
export const CLIENT_PROJECT_NAV: NavSection[] = [
  {
    items: [
      { label: 'Overview', href: '', icon: PanelsTopLeft },
      { label: 'Plan', href: '/plan', icon: Workflow },
      { label: 'Results', href: '/results', icon: TrendingUp },
      { label: 'Content', href: '/content', icon: BookOpen },
      // §6.5 requires a client-facing calendar, and §6.4 requires it to be the
      // same calendar rather than a parallel one: this is the portfolio of one
      // project, filtered on the server to content explicitly shared with them.
      { label: 'Calendar', href: '/calendar', icon: CalendarDays },
      { label: 'Business information', href: '/business-info', icon: BookOpen, secondary: true },
      { label: 'Connected accounts', href: '/connections', icon: Blocks, secondary: true },
    ],
  },
];

export function clientProjectNavHref(projectId: string, href: string): string {
  return `/client/projects/${projectId}${href}`;
}

/** Filters a section list down to what `role` may see. Admin always passes. */
export function visibleSections(
  sections: NavSection[],
  role: OperatorRole | undefined,
): NavSection[] {
  const allows = (roles: OperatorRole[] | undefined) =>
    !roles || !role || role === 'admin' || roles.includes(role);

  if (!role) return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => allows(item.roles)),
      groups: section.groups
        ?.filter((group) => allows(group.roles))
        .map((group) => ({ ...group, items: group.items.filter((item) => allows(item.roles)) }))
        .filter((group) => group.items.length > 0),
    }))
    .filter((section) => section.items.length > 0)
    .filter((section) => allows(section.roles));
}

/** True when `href` is the current location or a parent of it. */
export function isActiveHref(pathname: string, href: string): boolean {
  if (href === '/ops' || href === '/client') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Every href in a section, including its staff-only groups. */
export function allHrefs(section: NavSection): string[] {
  return [
    ...section.items.map((item) => item.href),
    ...(section.groups ?? []).flatMap((group) => group.items.map((item) => item.href)),
  ];
}

/**
 * True when the current path is inside a collapsible section.
 *
 * §3.2 wants Team tools collapsed and its state remembered; it must still show
 * where the reader currently is, so the shell renders a collapsed section
 * expanded while a child route is active **without** overwriting the remembered
 * preference. Otherwise a staff member who collapsed the group would silently
 * lose the only cue pointing at their current page.
 */
export function sectionContainsPath(section: NavSection, pathname: string): boolean {
  return allHrefs(section).some((href) => href !== '' && isActiveHref(pathname, href));
}

/** The single glob icon used for a project whose domain has no favicon. */
export const PROJECT_FALLBACK_ICON = Globe;
