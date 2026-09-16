'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Clock,

  Users,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { getOverview, type OperationsOverview } from '@/services/operations';

/**
 * OP01 — Today.
 *
 * design_plan.md §4.2 describes this as the operator's landing surface:
 * "Assigned work, clients needing attention, failed runs, approvals, today's
 * commitments."
 *
 * The page is built from one server-aggregated call (`GET /operations/overview`)
 * rather than several list calls. §10.3 warns that the global rate limit is
 * 100 requests/minute/IP and that an office shares one IP, so a landing page
 * that fans out is exactly the pattern G14 exists to prevent.
 *
 * Every number here is a count the server computed. Nothing is estimated, and
 * a section with no data says "None" rather than showing a zero that reads as
 * a measured result.
 */
export default function TodayPage() {
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const result = await getOverview({ signal });
      setOverview(result);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught : new Error('Unknown error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) return <TodaySkeleton />;

  if (error) {
    const isNotBuilt =
      error instanceof ApiError && (error.kind === 'not-found' || error.kind === 'unknown');

    return (
      <div className="space-y-6">
        <h1 className="text-title font-semibold tracking-tight">Today</h1>
        <Alert variant={isNotBuilt ? 'default' : 'destructive'} role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>
            {isNotBuilt ? 'This view is not available yet' : 'Could not load your workspace'}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {isNotBuilt
                ? 'The portfolio summary endpoint (design_plan G14) is not answering on this deployment yet. The individual client and project pages still work.'
                : error.message}
            </p>
            {/* §3.5 — a 403 must not retry on a loop; only offer a retry for
                failures where retrying can actually help. */}
            {!(error instanceof ApiError && error.kind === 'forbidden') ? (
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="sm">
              <Link href="/ops/clients">Go to clients</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!overview) return null;

  const nothingPending =
    overview.work.overdue === 0 &&
    overview.work.blocked === 0 &&
    overview.approvals.pending === 0 &&
    overview.alerts.critical === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold tracking-tight">Today</h1>
          <p className="mt-1 text-table text-muted-foreground">
            {overview.scope === 'assigned'
              ? `Your assigned clients (${formatNumber(overview.assignedClientCount ?? 0)})`
              : 'Whole portfolio'}
          </p>
        </div>
        <Button asChild>
          <Link href="/ops/clients">
            <Users aria-hidden="true" className="mr-2 h-4 w-4" />
            Clients
          </Link>
        </Button>
      </div>

      {nothingPending ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-success" />
            <div>
              <p className="text-table font-medium">Nothing overdue or blocked</p>
              <p className="text-meta text-muted-foreground">
                No overdue work, no blocked items, no pending approvals and no
                critical alerts across this scope.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Attention strip ─────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CountCard
          label="Overdue work"
          value={overview.work.overdue}
          icon={CalendarClock}
          tone={overview.work.overdue > 0 ? 'danger' : 'neutral'}
          href="/ops/work?filter=overdue"
        />
        <CountCard
          label="Blocked"
          value={overview.work.blocked}
          icon={CircleDot}
          tone={overview.work.blocked > 0 ? 'warning' : 'neutral'}
          href="/ops/work?filter=blocked"
        />
        <CountCard
          label="Awaiting review"
          value={overview.work.awaitingReview}
          icon={Clock}
          tone="neutral"
          href="/ops/work?filter=awaiting-review"
        />
        <CountCard
          label="Pending approvals"
          value={overview.approvals.pending}
          icon={CheckCircle2}
          tone={overview.approvals.pending > 0 ? 'warning' : 'neutral'}
          href="/ops/work?filter=approvals"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Portfolio ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Portfolio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Row
              label="Clients"
              value={overview.clients.total}
              detail={[
                overview.clients.active > 0 ? `${overview.clients.active} active` : null,
                overview.clients.paused > 0 ? `${overview.clients.paused} paused` : null,
                overview.clients.churned > 0 ? `${overview.clients.churned} churned` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              href="/ops/clients"
            />
            <Row
              label="Projects"
              value={overview.projects.total}
              detail={Object.entries(overview.projects.byStatus)
                .map(([status, count]) => `${count} ${status}`)
                .join(' · ')}
              href="/ops/projects"
            />
            <Row
              label="Reports"
              value={overview.reports.total}
              detail={Object.entries(overview.reports.byStatus)
                .map(([status, count]) => `${count} ${status}`)
                .join(' · ')}
              href="/ops/reports"
            />
          </CardContent>
        </Card>

        {/* ── Alerts and staleness ──────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Needs a look</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Row
              label="Critical alerts"
              value={overview.alerts.critical}
              detail={[
                overview.alerts.warning > 0 ? `${overview.alerts.warning} warning` : null,
                overview.alerts.info > 0 ? `${overview.alerts.info} info` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              tone={overview.alerts.critical > 0 ? 'danger' : 'neutral'}
              href="/ops/work?filter=alerts"
            />
            <Row
              label="Stale sources"
              value={overview.staleSources}
              // §3.5 — staleness is not a failed result, and this copy says so.
              detail="Measurements past their agreed refresh window. Stale is not the same as failed."
              href="/ops/admin/connections"
            />
            {overview.leads.total > 0 ? (
              <Row
                label="Sales leads"
                value={overview.leads.total}
                detail={Object.entries(overview.leads.byStatus)
                  .map(([status, count]) => `${count} ${status}`)
                  .join(' · ')}
                href="/ops/sales"
              />
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type Tone = 'neutral' | 'warning' | 'danger';

const TONE_STYLES: Record<Tone, { value: string; ring: string }> = {
  neutral: { value: 'text-foreground', ring: 'border-border' },
  warning: { value: 'text-warning-foreground', ring: 'border-warning/30' },
  danger: { value: 'text-danger-foreground', ring: 'border-danger/30' },
};

/**
 * A count with its label and a link to the filtered view.
 *
 * A zero is rendered as a plain zero with neutral tone — never as a green
 * "success". Zero overdue items is the absence of a problem, not a measured
 * achievement, and §3.5 keeps those distinguishable.
 */
function CountCard({
  label,
  value,
  icon: Icon,
  tone,
  href,
}: {
  label: string;
  value: number;
  icon: typeof CalendarClock;
  tone: Tone;
  href: string;
}) {
  const styles = TONE_STYLES[tone];
  return (
    <Link
      href={href}
      className={`group rounded-xl border bg-surface p-4 transition-colors hover:bg-surface-sunken ${styles.ring}`}
    >
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-2 text-kpi font-semibold tabular-nums ${styles.value}`}>
        {formatNumber(value)}
      </div>
      <div className="mt-1 flex items-center gap-1 text-meta text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        View
        <ArrowRight aria-hidden="true" className="h-3 w-3" />
      </div>
    </Link>
  );
}

function Row({
  label,
  value,
  detail,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <div className="flex items-baseline justify-between gap-4">
      <div className="min-w-0">
        <div className="text-table">{label}</div>
        {detail ? <div className="mt-0.5 text-meta text-muted-foreground">{detail}</div> : null}
      </div>
      <div className={`shrink-0 text-subsection font-semibold tabular-nums ${TONE_STYLES[tone].value}`}>
        {formatNumber(value)}
      </div>
    </div>
  );

  return href ? (
    <Link href={href} className="-mx-2 block rounded-md px-2 py-1 transition-colors hover:bg-surface-sunken">
      {body}
    </Link>
  ) : (
    body
  );
}

function TodaySkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
