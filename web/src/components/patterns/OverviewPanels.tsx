'use client';

import Link from 'next/link';
import { ArrowRight, Clock, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber } from '@/lib/format';
import {
  OVERVIEW_UPCOMING_LIMIT,
  type OverviewActionItem,
  type OverviewSections,
  type OverviewSection,
} from '@/services/overview';

/**
 * §5.1's Overview panels, shared by the client and staff reads.
 *
 * The two audiences get the same panels on purpose: the server composes one
 * overview and the staff read adds a "Team attention" shortcut *below* the
 * client-equivalent information. Rendering them from one implementation is what
 * makes "what the client sees" and "what the team sees" unable to drift — a
 * copy change lands on both, and neither page can quietly grow a fourth action
 * card.
 *
 * The hard limits are visible here rather than left to each page's taste:
 * at most three action cards with the true total spelled out, at most five
 * upcoming items, one sentence per panel saying what it covers, and no panel
 * that turns a missing measurement into a zero.
 *
 * §5.6's presentation rules are enforced in this file:
 *
 *  - the order is the server's (overdue and time-sensitive first); these
 *    components never re-sort;
 *  - a card carries what the item is, why it is here, by when, and what
 *    "done" means — and no control that completes it. Opening is a navigation
 *    to the screen that owns the item, and the item stays open until it is
 *    resolved there.
 */

type ActionPanel = OverviewSections['actions'];
type UpcomingPanel = OverviewSections['upcomingContent'];
type PlanPanel = OverviewSections['plan'];
type ReportPanel = OverviewSections['report'];

function PanelShell({
  heading,
  id,
  context,
  children,
}: {
  heading: string;
  id: string;
  context?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-subsection font-semibold tracking-tight">
          {heading}
        </h2>
        {context ? <span className="text-meta text-muted-foreground">{context}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * §4.5's degraded panel when the *composed read itself* failed.
 *
 * A panel with no section at all renders a skeleton, which is right while the
 * request is in flight and wrong once it has failed: a skeleton that never
 * resolves reads as "still loading" forever. Handing the panels this envelope
 * instead makes a failed request say so, per panel, on a page that stays
 * usable.
 */
export function overviewReadFailedSection(reason: string): OverviewSection<never> {
  return { status: 'unavailable', data: null, reason, reasonCode: 'read-failed' };
}

/** §4.5's degraded panel: the server's safe sentence, and the page intact. */
function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <p className="text-table text-muted-foreground">{reason}</p>
        <p className="text-meta text-muted-foreground">Everything else on this page is up to date.</p>
      </CardContent>
    </Card>
  );
}

// ── §5.6 "Needs your action" ────────────────────────────────────────────────

export function ActionPanelView({ section }: { section: ActionPanel | undefined }) {
  if (!section) {
    return (
      <PanelShell heading="Needs your action" id="action-heading">
        <Skeleton className="h-28 rounded-xl" />
      </PanelShell>
    );
  }

  if (section.status === 'unavailable' || !section.data) {
    return (
      <PanelShell heading="Needs your action" id="action-heading">
        <UnavailablePanel reason={section.reason ?? 'We could not load this part of the overview just now.'} />
      </PanelShell>
    );
  }

  const panel = section.data;
  const remaining = Math.max(panel.total - panel.items.length, 0);

  return (
    <PanelShell
      heading="Needs your action"
      id="action-heading"
      context={panel.total > 0 ? `${panel.total} waiting · showing ${panel.items.length}` : null}
    >
      {panel.total === 0 ? (
        <Card>
          <CardContent className="py-4 text-table text-muted-foreground">{panel.allClearMessage}</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {panel.items.map((item) => (
            <ActionCard key={`${item.sourceType}:${item.sourceId}`} item={item} />
          ))}
        </div>
      )}

      {panel.total > 0 ? (
        <div className="space-y-1 text-meta text-muted-foreground">
          <p className="flex flex-wrap items-center gap-3">
            {/* The TRUE total, never the number of cards on screen. */}
            <span>
              {remaining > 0
                ? `${remaining} more item${remaining === 1 ? '' : 's'} waiting. This list shows at most ${panel.limit}.`
                : 'Nothing else is waiting.'}
            </span>
            <Link href={panel.viewAllHref} className="text-primary underline underline-offset-4">
              View all
            </Link>
          </p>
          <p>{panel.order}</p>
        </div>
      ) : null}
    </PanelShell>
  );
}

function ActionCard({ item }: { item: OverviewActionItem }) {
  const overdue = item.severity === 'overdue';
  const blocking = item.severity === 'blocking';

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* Severity is the server's §5.6 classification — never inferred here. */}
        {overdue ? (
          <span className="inline-flex items-center gap-1 text-meta font-medium text-warning-foreground">
            <Clock aria-hidden="true" className="h-3.5 w-3.5" />
            Overdue
          </span>
        ) : blocking ? (
          <span className="text-meta font-medium text-warning-foreground">Blocking other work</span>
        ) : null}
        {item.deadline ? (
          <span className="text-meta text-muted-foreground">
            Due <Timestamp value={item.deadline} dateOnly />
          </span>
        ) : null}
      </div>

      <p className="text-table font-medium text-foreground">{item.title}</p>
      <p className="text-meta text-muted-foreground">{item.reason}</p>
      <p className="mt-auto text-meta text-muted-foreground">{item.completionCondition}</p>

      {/* Opening is not completing (§5.6): this links to the screen that owns
          the item, and nothing on this card resolves it. */}
      <Button asChild size="sm" variant="outline" className="w-fit">
        <Link href={item.destination}>
          Open
          <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
        </Link>
      </Button>
    </Card>
  );
}

// ── §5.1 "Upcoming content" ─────────────────────────────────────────────────

export function UpcomingPanelView({ section }: { section: UpcomingPanel | undefined }) {
  if (!section) {
    return (
      <PanelShell heading="Upcoming content" id="upcoming-heading">
        <Skeleton className="h-32 rounded-xl" />
      </PanelShell>
    );
  }

  if (section.status === 'unavailable' || !section.data) {
    // §4.5: the calendar is the one panel whose whole data set comes from a
    // single source, so its failure is stated rather than shown as empty.
    return (
      <PanelShell heading="Upcoming content" id="upcoming-heading">
        <UnavailablePanel reason={section.reason ?? 'We could not load this part of the overview just now.'} />
      </PanelShell>
    );
  }

  const panel = section.data;
  const remaining = Math.max(panel.totalInWindow - panel.items.length, 0);

  return (
    <PanelShell
      heading="Upcoming content"
      id="upcoming-heading"
      context={`${panel.window.from} to ${panel.window.to} (${panel.window.timezone})`}
    >
      <Card>
        <CardContent className="space-y-3 py-4">
          {panel.items.length === 0 ? (
            <p className="text-table text-muted-foreground">
              {section.reason ?? 'Nothing is scheduled in this window yet.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {panel.items.map((item) => (
                <li key={item.scheduleId} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <Link href={item.href} className="text-table font-medium text-primary hover:underline">
                      {item.title}
                    </Link>
                    <span className="block text-meta text-muted-foreground">
                      {item.contentTypeLabel} · {item.channelLabel} · {item.stateLabel}
                      {item.pastDue && item.pastDueLabel ? ` · ${item.pastDueLabel}` : ''}
                    </span>
                  </span>
                  {/* Both readings: the local one the reader diarises, and the
                      stored instant the system acts on. */}
                  <span className="text-meta text-muted-foreground">
                    {item.plannedLocalDate} {item.plannedLocalTime} ({item.timezone})
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
            {remaining > 0 ? (
              <span>
                Showing {panel.items.length} of {panel.totalInWindow} in this window; this list stops at{' '}
                {OVERVIEW_UPCOMING_LIMIT}.
              </span>
            ) : panel.items.length > 0 ? (
              <span>Everything scheduled in this window is listed.</span>
            ) : null}
            {panel.truncated ? (
              <span className="text-warning-foreground">
                The calendar read itself was shortened, so the total above may be incomplete.
              </span>
            ) : null}
            <Link href={panel.calendarHref} className="text-primary underline underline-offset-4">
              Open the calendar
            </Link>
          </div>
        </CardContent>
      </Card>
    </PanelShell>
  );
}

// ── §5.1 footer: plan progress ──────────────────────────────────────────────

export function PlanPanelView({ section }: { section: PlanPanel | undefined }) {
  return (
    <PanelShell heading="Plan progress" id="plan-heading">
      <Card>
        <CardContent className="space-y-2 py-4">
          {!section ? (
            <Skeleton className="h-5 w-56" />
          ) : section.status === 'unavailable' || !section.data ? (
            <p className="text-table text-muted-foreground">
              {section.reason ?? 'We could not load this part of the overview just now.'}
            </p>
          ) : (
            <>
              {/* The server's sentence, rendered verbatim, so this number and
                  the frozen one in a released report cannot drift. */}
              <p className="text-table font-medium text-foreground">{section.data.label}</p>
              <p className="text-meta text-muted-foreground">{section.data.scopeNote}</p>
              <Link
                href={section.data.planHref}
                className="inline-flex items-center gap-1 text-meta font-medium text-primary hover:underline"
              >
                Open the plan
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    </PanelShell>
  );
}

// ── §5.1 footer: the released report (§14.6) ────────────────────────────────

/**
 * The released report, labelled as released.
 *
 * The figure here is the **frozen** one from the report's snapshot. It is not
 * the live score above, and the panel says so: a later live score does not move
 * it, and neither does a new draft revision — only a release does.
 */
export function ReportPanelView({
  section,
  heading = 'Latest report',
  id = 'report-heading',
}: {
  section: ReportPanel | undefined;
  heading?: string;
  id?: string;
}) {
  if (!section) {
    return (
      <PanelShell heading={heading} id={id}>
        <Skeleton className="h-24 rounded-xl" />
      </PanelShell>
    );
  }

  if (section.status === 'unavailable' || !section.data) {
    return (
      <PanelShell heading={heading} id={id}>
        <UnavailablePanel reason={section.reason ?? 'We could not load this part of the overview just now.'} />
      </PanelShell>
    );
  }

  const panel = section.data;
  const frozen = panel.releasedDigitalPerformance;

  return (
    <PanelShell heading={heading} id={id}>
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FileText aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                <span className="truncate text-table font-medium">{panel.title}</span>
              </div>
              <p className="mt-1 text-meta text-muted-foreground">
                Released <Timestamp value={panel.releasedAt} dateOnly /> · revision {panel.revision}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {panel.releasedScoreTotal !== null ? (
                <span className="text-subsection font-semibold tabular-nums">
                  {formatNumber(panel.releasedScoreTotal)}
                </span>
              ) : (
                <span className="text-meta text-muted-foreground">Not scored</span>
              )}
              <Button asChild size="sm" variant="outline">
                <Link href={panel.href}>
                  Open report
                  <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </div>

          {/* §14.6's live/report distinction, in the reader's words. */}
          <p className="text-meta text-muted-foreground">
            {panel.releasedLabel} — this figure does not change when the live score is recalculated.
          </p>

          {frozen ? (
            <p className="text-meta text-muted-foreground">
              That release froze {frozen.measuredBucketCount} of {frozen.applicableBucketCount} score areas
              {frozen.total !== null ? ` (score ${formatNumber(frozen.total)})` : ' (no overall score in that release)'}
              {frozen.frozenAt ? (
                <>
                  , as they stood on <Timestamp value={frozen.frozenAt} dateOnly />
                </>
              ) : null}
              .
            </p>
          ) : null}

          {panel.releasedPlanProgress ? (
            <p className="text-meta text-muted-foreground">
              Plan progress as released: {panel.releasedPlanProgress.label}.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </PanelShell>
  );
}

// ── §5.1 staff shortcut ─────────────────────────────────────────────────────

/**
 * "Team attention" — the staff-only shortcut, and the only panel the operator
 * read adds.
 *
 * It sits below the client-equivalent information because that is what §5.1
 * asks for: the team sees the same page the client sees first, then the extra
 * thing the client does not have. Like the client queue it shows at most three
 * items and the true total, so "three cards" is never read as "three items".
 */
export function TeamAttentionPanelView({
  section,
}: {
  section: OverviewSection<{
    items: OverviewActionItem[];
    total: number;
    limit: number;
    order: string;
    href: string;
  }> | undefined;
}) {
  if (!section) {
    return (
      <PanelShell heading="Team attention" id="team-attention-heading">
        <Skeleton className="h-24 rounded-xl" />
      </PanelShell>
    );
  }

  if (section.status === 'unavailable' || !section.data) {
    return (
      <PanelShell heading="Team attention" id="team-attention-heading">
        <UnavailablePanel reason={section.reason ?? 'We could not load this part of the overview just now.'} />
      </PanelShell>
    );
  }

  const panel = section.data;
  const remaining = Math.max(panel.total - panel.items.length, 0);

  return (
    <PanelShell
      heading="Team attention"
      id="team-attention-heading"
      context={panel.total > 0 ? `${panel.total} for the team · showing ${panel.items.length}` : null}
    >
      <Card>
        <CardContent className="space-y-3 py-4">
          {panel.total === 0 ? (
            <p className="text-table text-muted-foreground">{section.reason ?? 'Nothing is waiting on the team.'}</p>
          ) : (
            <ul className="divide-y divide-border">
              {panel.items.map((item) => (
                <li key={`${item.sourceType}:${item.sourceId}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <Link href={item.destination} className="text-table font-medium text-primary hover:underline">
                      {item.title}
                    </Link>
                    <span className="block text-meta text-muted-foreground">{item.reason}</span>
                  </span>
                  <span className="text-meta text-muted-foreground">
                    {item.severity === 'overdue' ? 'Overdue' : item.severity === 'blocking' ? 'Blocking' : 'Normal'}
                    {item.deadline ? (
                      <>
                        {' · due '}
                        <Timestamp value={item.deadline} dateOnly />
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-1 text-meta text-muted-foreground">
            {remaining > 0 ? <p>{remaining} more for the team.</p> : null}
            <Link href={panel.href} className="text-primary underline underline-offset-4">
              Open the team queue
            </Link>
          </div>
        </CardContent>
      </Card>
    </PanelShell>
  );
}
