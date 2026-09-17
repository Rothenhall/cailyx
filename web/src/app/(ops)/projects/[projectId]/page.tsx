'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import {
  ActionPanelView,
  overviewReadFailedSection,
  PlanPanelView,
  ReportPanelView,
  TeamAttentionPanelView,
  UpcomingPanelView,
} from '@/components/patterns/OverviewPanels';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScoreSummary, ScoreSummarySkeleton } from '@/components/patterns/ScoreSummary';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { projectStatusLabel, projectStatusTone } from '@/lib/status-tones';
import { getProject } from '@/services/projects';
import { getStaffOverview, type StaffOverviewView } from '@/services/overview';
import type { ProjectDetail } from '@/services/types';

/**
 * PJ01 — Project overview, recomposed as §5.1's Overview (P15).
 *
 * platform_improvement_plan.md §5.1: one prominent overall score with "View
 * results", the applicable bucket cards, "Needs your action" (≤3 cards + the
 * truthful total + "View all"), "Upcoming content" (≤5 items + calendar link),
 * a compact plan/report footer — and *"for staff, a small 'Team attention'
 * shortcut can sit below the main client-equivalent information."*
 *
 * ## The staff read is the client read plus one panel
 *
 * `GET /projects/:id/overview` composes the client-equivalent panels from the
 * project's own client and then adds `teamAttention`. This page renders the
 * same components the client's Overview renders (`@/components/patterns/
 * OverviewPanels`), in the same order, with the team shortcut last — which is
 * what "below the main client-equivalent information" means, and what stops the
 * two pages drifting apart. Only three things differ from the client's screen:
 * the header (operator statuses and connections), the destinations the server
 * put in the links, and the presence of the last panel.
 *
 * ## The §5.1 limits, and what they removed from this page
 *
 * §5.1: *"Do not fill the page with audit counts, run histories, social
 * discovery tables, all tasks, or disconnected widgets."* This page used to be
 * exactly that — four artifact counts, a score-history chart, a month preview
 * of the calendar and four "not available yet" rows — and each figure that
 * survives here links to the screen that owns it. What was removed did not
 * disappear:
 *
 *  - artifact counts and the score history → `research/website` and the other
 *    research reads, which is where the runs themselves are;
 *  - the calendar preview → the calendar, and the §5.1 "Upcoming content" panel
 *    that replaces it (30 days, ≤5 items, honest total);
 *  - project details and cadence → `settings` and `monitoring`;
 *  - the "Priorities / cycle commitments / pending approvals — not available
 *    yet" rows → gone because they were no longer true. Those surfaces exist
 *    now, and what is genuinely outstanding for this project arrives in "Needs
 *    your action" and "Team attention" with its real state, its deadline and
 *    the place it can be resolved. A page that says a deployed feature is
 *    missing is worse than one that omits it.
 *
 * ## §5.7 and §4.5
 *
 * Loading this page starts nothing: both reads are pure storage reads, and the
 * score panel shows the last stored run rather than building one. Nothing here
 * completes an action item — every card is a link to the screen that owns it,
 * and resolving it happens there (§5.6).
 */
export default function ProjectOverviewPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [overview, setOverview] = useState<StaffOverviewView | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setProject(await getProject(projectId, { signal }));

        // The overview is a second, composed read. Its failure is reported on
        // the page rather than thrown: the project identity, its status, the
        // setup warning and the links stay usable (§4.5).
        try {
          setOverview(await getStaffOverview(projectId, { signal }));
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
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!project) {
    // The loading state is shaped like the page that replaces it: identity,
    // the score block, then the panels.
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

  const setupFailed = project.onboardingStatus === 'failed';
  const header = overview?.header ?? null;
  const sections = overview?.sections ?? null;

  // §4.5 when the composed read itself failed: each panel says so rather than
  // showing a skeleton that will never resolve.
  const unread = overviewFailed
    ? overviewReadFailedSection('We could not load this part of the overview just now.')
    : undefined;

  return (
    <div className="space-y-6">
      {/* §3.3 — the banner states exactly what this page is scoped to. */}
      <ScopeBanner
        scope={{
          projectName: project.name,
          domain: project.domain,
          mode: 'live',
        }}
      />

      <PageHeader
        breadcrumbs={[{ label: 'Projects', href: '/ops/projects' }, { label: project.name }]}
        title={project.name}
        context={project.domain}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={projectStatusLabel(project.status)}
              tone={projectStatusTone(project.status)}
            />
            {project.onboardingStatus && project.onboardingStatus !== 'completed' ? (
              <StatusPill
                label={
                  setupFailed
                    ? 'Setup failed'
                    : project.onboardingStatus === 'running'
                      ? `Setting up${project.onboardingStep ? `: ${project.onboardingStep}` : ''}`
                      : 'Setup not started'
                }
                tone={
                  setupFailed ? 'danger' : project.onboardingStatus === 'running' ? 'info' : 'unmeasured'
                }
              />
            ) : null}
          </span>
        }
        secondaryActions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}/connections`}>Connections</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}/settings`}>Settings</Link>
            </Button>
          </>
        }
      />

      <p className="text-table text-muted-foreground">
        {header?.explanation ??
          'The score, anything waiting on the client or the team, what is coming up, and the latest released report.'}
      </p>

      {/*
        A failed day-1 pipeline is the single most important thing on this page:
        the project looks set up but its evidence is incomplete. §3.5's partial
        rule applies — show what did succeed, and name what did not.
      */}
      {setupFailed ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Setup did not finish</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {project.onboardingStep
                ? `The setup run stopped during "${project.onboardingStep}". Anything completed before that stage is still available below.`
                : 'The setup run did not complete. Anything it produced before stopping is still available below.'}
            </p>
            {project.onboardingError ? (
              <p className="text-meta">{project.onboardingError}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {overviewFailed ? (
        <Alert>
          <Info aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>We could not load the composed overview just now</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              The project itself was read successfully; only the assembled panels failed. Nothing
              below should be read as an empty result.
            </span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── Client-equivalent information, in §5.1's order ────────────────── */}

      {/* §5.1's one prominent score. `audience="operator"` is what makes the
          "How this score works" sheet carry the full stored calculation (§5.5)
          — the client's sheet stops at the plain-English explanation. */}
      <ScoreSummary section={sections?.score ?? unread} projectId={projectId} audience="operator" />

      <ActionPanelView section={sections?.actions ?? unread} />

      <UpcomingPanelView section={sections?.upcomingContent ?? unread} />

      <PlanPanelView section={sections?.plan ?? unread} />

      <ReportPanelView section={sections?.report ?? unread} />

      {/* ── §5.1's staff shortcut, below the client-equivalent information ── */}
      <TeamAttentionPanelView section={sections?.teamAttention ?? unread} />

      {/* Navigation, not widgets: the screens §5.1 moved off this page. */}
      <nav aria-label="More on this project" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-meta">
        <Link href={`/projects/${projectId}/research/website`} className="text-primary underline underline-offset-4">
          Website health
        </Link>
        <Link href={`/projects/${projectId}/priorities`} className="text-primary underline underline-offset-4">
          Priorities
        </Link>
        <Link href={`/projects/${projectId}/cycles`} className="text-primary underline underline-offset-4">
          Plan &amp; cycles
        </Link>
        <Link href={`/projects/${projectId}/calendar`} className="text-primary underline underline-offset-4">
          Calendar
        </Link>
        <Link href={`/projects/${projectId}/monitoring`} className="text-primary underline underline-offset-4">
          Monitoring
        </Link>
        <Link href={`/projects/${projectId}/reports`} className="text-primary underline underline-offset-4">
          Reports
        </Link>
        <Link href={`/projects/${projectId}/runs`} className="text-primary underline underline-offset-4">
          Run history
        </Link>
      </nav>
    </div>
  );
}
