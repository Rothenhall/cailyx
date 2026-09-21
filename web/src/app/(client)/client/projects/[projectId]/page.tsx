'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import {
  ActionPanelView,
  overviewReadFailedSection,
  PlanPanelView,
  ReportPanelView,
  UpcomingPanelView,
} from '@/components/patterns/OverviewPanels';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScoreSummary, ScoreSummarySkeleton } from '@/components/patterns/ScoreSummary';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { onboardingStatusTone } from '@/lib/status-tones';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import { getPortalOverview, type PortalOverviewView } from '@/services/overview';

/**
 * CP03 — Project home, recomposed as §5.1's Overview (P15).
 *
 * 2026-09-21: this is the page `CLIENT_PROJECT_NAV` now labels "Dashboard" —
 * a nav relabel only, no content change. It is still the same composed
 * Overview read (`getPortalOverview`), and its "More on this project" links
 * row below is where Approvals stays reachable now that the new nav tree has
 * no top-level Approvals item (see `navigation.ts`'s `CLIENT_PROJECT_NAV` doc
 * comment for why).
 *
 * platform_improvement_plan.md §5.1: *"one prominent overall score with 'View
 * results', applicable bucket cards, 'Needs your action' (≤3 cards + truthful
 * total + 'View all'), 'Upcoming content' (≤5 items + calendar link), compact
 * footer (30-day plan progress + latest report link). Do not fill the page with
 * audit counts, run histories, social discovery tables, all tasks, or
 * disconnected widgets."*
 *
 * ## The page is composed on the server, and this file renders what it gets
 *
 * `GET /portal/projects/:id/overview` returns the five panels already
 * assembled, each in its own section envelope. This screen therefore cannot
 * read a sixth source, cannot trigger work by loading (§5.7 — every panel is a
 * pure storage read), and cannot accidentally produce a fourth action card:
 * the caps are applied at the source *and* in the projection.
 *
 * ## The panels are shared with the staff overview
 *
 * `@/components/patterns/OverviewPanels` holds the panel rendering for both
 * audiences, and this page renders exactly the same components the operator's
 * overview does. That is deliberate: "what the client sees" and "what the team
 * sees" should not be able to drift apart, and the §5.6 presentation rules
 * (order, ≤3 cards with the true total, no control that completes an item)
 * belong to one implementation rather than to each page's taste.
 *
 * ## §4.5 panel isolation, in both directions
 *
 *  - **Server-side**: a failed panel arrives as `status: 'unavailable'` with a
 *    safe sentence, so one broken source degrades one panel.
 *  - **Client-side**: the whole overview is one request, but if that request
 *    itself fails the page does not blank — every panel says it could not be
 *    loaded, the project identity still renders, and a retry is offered. The
 *    skeletons in the loading state are shaped like the panels they replace.
 *
 * ## What this page deliberately no longer carries
 *
 * Goals, baseline readiness, the work list, audit counts, run history and the
 * calendar preview each have their own screen, and §5.1 calls a page full of
 * them a page of disconnected widgets. They are one click away in the links
 * row at the bottom — including the readiness question, which the "Needs your
 * action" panel answers directly when it is genuinely waiting on the client.
 */
export default function ClientProjectHomePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  /** `undefined` while loading; `null` when the project is not this client's. */
  const [project, setProject] = useState<PortalProjectSummary | null | undefined>(undefined);
  const [overview, setOverview] = useState<PortalOverviewView | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const projects = await listPortalProjectSummaries({ signal });
        const found = projects.find((entry) => entry.id === projectId) ?? null;
        setProject(found);
        if (!found) {
          setOverview(null);
          return;
        }

        // The overview is one composed read. Its own failure is reported on the
        // page rather than thrown: the identity, the setup warning and the
        // links stay usable.
        try {
          setOverview(await getPortalOverview(projectId, { signal }));
          setOverviewFailed(false);
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setOverview(null);
          setOverviewFailed(true);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Project" />
        {/* §4.1 — a missing project and another client's project read alike, so
            this cannot be used to probe for project ids. */}
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (project === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <ScoreSummarySkeleton />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (project === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Project" />
        <EmptyState
          variant="not-measured"
          subject="this project"
          prerequisite="It is not one of the projects on your account. Your delivery lead can add it."
          action={{ label: 'Back to your projects', href: '/client/projects' }}
        />
      </div>
    );
  }

  const header = overview?.header ?? null;
  const sections = overview?.sections ?? null;

  /**
   * §4.5 when the composed read itself failed: every panel says it could not be
   * loaded rather than showing a skeleton that will never resolve. This is a
   * different failure from a single panel degrading, and the page keeps its
   * identity, its setup warning and its links either way.
   */
  const unread = overviewFailed
    ? overviewReadFailedSection('We could not load this part of your overview just now.')
    : undefined;

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />

      <PageHeader
        breadcrumbs={[{ label: 'Your projects', href: '/client/projects' }, { label: project.name }]}
        title={project.name}
        context={<span className="font-mono text-meta">{project.domain}</span>}
        status={
          <StatusPill
            label={setupLabel(project)}
            tone={project.onboardingStatus ? onboardingStatusTone(project.onboardingStatus) : 'unmeasured'}
          />
        }
        primaryAction={{ label: 'Open the plan', href: `/client/projects/${projectId}/plan` }}
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/client/projects/${projectId}/welcome`}>Welcome checklist</Link>
          </Button>
        }
      />

      {/* The §4.2 one-sentence explanation of what this page is. */}
      <p className="text-table text-muted-foreground">
        {header?.explanation ??
          'Your score, anything waiting on you, what is coming up, and your latest report — the whole picture on one page.'}
      </p>

      {project.onboardingStatus === 'failed' ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Setup did not finish</AlertTitle>
          <AlertDescription>
            {project.onboardingStep
              ? `Setup stopped during “${project.onboardingStep}”. Anything completed before that stage is still available, and the score says which areas have no measurement yet.`
              : 'Setup did not complete. Anything it produced before stopping is still available, and the score says which areas have no measurement yet.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {overviewFailed ? (
        <Alert>
          <Info aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>We could not load your overview just now</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              Your project is fine — this is our read failing. Nothing is waiting on you because of it.
            </span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── §5.1's one prominent score ───────────────────────────────────── */}
      <ScoreSummary section={sections?.score ?? unread} projectId={projectId} audience="client" />

      {/* ── §5.6 needs your action ───────────────────────────────────────── */}
      <ActionPanelView section={sections?.actions ?? unread} />

      {/* ── §5.1 upcoming content ────────────────────────────────────────── */}
      <UpcomingPanelView section={sections?.upcomingContent ?? unread} />

      {/* ── §5.1's compact footer: plan progress + latest report ─────────── */}
      <PlanPanelView section={sections?.plan ?? unread} />

      <ReportPanelView section={sections?.report ?? unread} />

      {/* Navigation, not widgets: everything §5.1 moved off this page has a
          home, and the reader should not have to hunt for it. */}
      <nav aria-label="More on this project" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-meta">
        <Link href={`/client/projects/${projectId}/performance`} className="text-primary underline underline-offset-4">
          Performance
        </Link>
        <Link href={`/client/projects/${projectId}/work`} className="text-primary underline underline-offset-4">
          Work
        </Link>
        <Link href={`/client/projects/${projectId}/calendar`} className="text-primary underline underline-offset-4">
          Calendar
        </Link>
        <Link href={`/client/projects/${projectId}/reports`} className="text-primary underline underline-offset-4">
          Reports
        </Link>
        <Link href="/client/approvals" className="text-primary underline underline-offset-4">
          Approvals
        </Link>
        <Link href="/client/messages" className="text-primary underline underline-offset-4">
          Messages
        </Link>
      </nav>
    </div>
  );
}

function setupLabel(project: PortalProjectSummary): string {
  switch (project.onboardingStatus) {
    case 'completed':
      return 'Setup complete';
    case 'running':
      return 'Setting up';
    case 'failed':
      return 'Setup stopped';
    case 'pending':
      return 'Setup not started';
    default:
      return 'Setup state not reported';
  }
}
