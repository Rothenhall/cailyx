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
  Gauge,
  Globe,
  Layers,
  Link2,
  ListChecks,
  Megaphone,
  MessageSquare,
  Newspaper,
  PanelsTopLeft,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  UserCog,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { OperatorRole } from '@/services/types';

/**
 * The navigation model from design_plan.md §2.3, as data.
 *
 * Two rules from that section are encoded here rather than left to each shell:
 *
 *  - **"Client navigation never contains an all-clients selector."** The client
 *    tree below simply has no such entry; `ClientShell` renders from this list,
 *    so the rule holds by construction.
 *  - **"One-project clients land directly in that project's home context."**
 *    That is a routing decision, handled by the client shell's redirect, not by
 *    hiding a nav item.
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
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

/** Operator workspace — §2.3 "Operator workspace". */
export const OPERATOR_NAV: NavSection[] = [
  {
    items: [
      { label: 'Today', href: '/ops', icon: Gauge },
      { label: 'Clients', href: '/ops/clients', icon: Building2 },
      { label: 'My Work', href: '/ops/work', icon: ListChecks },
      { label: 'Calendar', href: '/ops/calendar', icon: CalendarDays },
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
      { label: 'People', href: '/ops/admin/people', icon: UserCog, roles: ['admin'] },
      {
        label: 'Service connections',
        href: '/ops/admin/connections',
        icon: Blocks,
        roles: ['admin', 'delivery-lead'],
      },
      { label: 'Rubrics', href: '/ops/admin/rubrics', icon: Target, roles: ['admin'] },
      { label: 'Budgets', href: '/ops/admin/budgets', icon: CircleDollarSign, roles: ['admin'] },
      { label: 'Activity', href: '/ops/admin/activity', icon: Activity, roles: ['admin'] },
      { label: 'Templates', href: '/ops/admin/templates', icon: Layers, roles: ['admin'] },
      { label: 'Organization', href: '/ops/admin/settings', icon: Settings, roles: ['admin'] },
    ],
  },
];

/**
 * Within a project — §2.3 "Within a project".
 *
 * `href` values are relative to `/projects/:projectId`; `projectNav` prefixes
 * them so a screen never hand-builds a project URL.
 */
export const PROJECT_NAV: NavSection[] = [
  {
    items: [{ label: 'Overview', href: '', icon: PanelsTopLeft }],
  },
  {
    label: 'Plan & Work',
    items: [
      { label: 'Priorities', href: '/priorities', icon: ListChecks },
      { label: 'Roadmap', href: '/roadmap', icon: Workflow },
      { label: 'Cycle board', href: '/cycles', icon: Layers },
      { label: 'Calendar', href: '/calendar', icon: CalendarDays },
    ],
  },
  {
    label: 'Research & Audits',
    items: [
      { label: 'Website health', href: '/research/website', icon: Wrench },
      { label: 'Search performance', href: '/research/search', icon: Search },
      { label: 'Traffic & acquisition', href: '/research/traffic', icon: TrendingUp },
      { label: 'AI visibility', href: '/research/ai', icon: Sparkles },
      { label: 'Site context', href: '/research/context', icon: BookOpen },
      { label: 'Prompt library', href: '/research/prompts', icon: ListChecks },
      { label: 'Brand & entities', href: '/research/entities', icon: Building2 },
      { label: 'Digital footprint', href: '/research/presence', icon: Globe },
      { label: 'Presence insights', href: '/research/presence/insights', icon: BarChart3 },
      { label: 'Competitors', href: '/research/competitors', icon: Users },
      { label: 'Keywords', href: '/research/keywords', icon: TrendingUp },
      { label: 'Search trackers', href: '/research/serp', icon: BarChart3 },
      { label: 'Markets', href: '/research/markets', icon: Globe },
      { label: 'Buyer research', href: '/research/journeys', icon: Compass },
      { label: 'Research campaigns', href: '/research/campaigns', icon: Megaphone },
    ],
  },
  {
    label: 'Content',
    items: [
      { label: 'Opportunities', href: '/content/opportunities', icon: Target },
      { label: 'Briefs & drafts', href: '/content', icon: Newspaper },
      { label: 'Generate', href: '/content/generate', icon: Sparkles },
      { label: 'Reviews', href: '/content/reviews', icon: ShieldCheck },
      { label: 'Calendar', href: '/content/calendar', icon: CalendarDays },
      { label: 'Page analysis', href: '/content/page-analysis', icon: Search },
      { label: 'Refreshes', href: '/content/refreshes', icon: Activity },
      { label: 'Data assets', href: '/content/data-assets', icon: BarChart3 },
      { label: 'Claims', href: '/claims', icon: ShieldCheck },
    ],
  },
  {
    label: 'Authority',
    items: [
      { label: 'Discovery', href: '/authority/opportunities', icon: Compass },
      { label: 'Outreach', href: '/authority/campaigns', icon: Megaphone },
      { label: 'Backlinks', href: '/authority/backlinks', icon: Link2 },
      { label: 'Mention health', href: '/authority/mentions', icon: ShieldCheck },
    ],
  },
  {
    items: [
      { label: 'Reports', href: '/reports', icon: FileText },
      { label: 'Monitoring', href: '/monitoring', icon: AlertTriangle },
      { label: 'Connections', href: '/connections', icon: Blocks },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

/** Builds an absolute project-scoped href from a `PROJECT_NAV` entry. */
export function projectNavHref(projectId: string, href: string): string {
  return `/projects/${projectId}${href}`;
}

/**
 * Client portal — §2.3 "Client portal".
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

/** Within one of the client's own projects — §2.3 "My Projects". */
export const CLIENT_PROJECT_NAV: NavSection[] = [
  {
    items: [
      { label: 'Overview', href: '', icon: PanelsTopLeft },
      { label: 'Plan', href: '/plan', icon: Workflow },
      { label: 'Results', href: '/results', icon: TrendingUp },
      { label: 'Content', href: '/content', icon: BookOpen },
      { label: 'Connections', href: '/connections', icon: Blocks },
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
  if (!role) return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => !item.roles || role === 'admin' || item.roles.includes(role),
      ),
    }))
    .filter((section) => section.items.length > 0);
}

/** True when `href` is the current location or a parent of it. */
export function isActiveHref(pathname: string, href: string): boolean {
  if (href === '/ops' || href === '/client') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The single glob icon used for a project whose domain has no favicon. */
export const PROJECT_FALLBACK_ICON = Globe;
