'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, ArrowRight, CalendarCheck, FileText, ListChecks, Target } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { TechnicalScoreHistory } from '@/components/charts/TechnicalScoreHistory';
import { projectStatusLabel, projectStatusTone } from '@/lib/status-tones';
import { getProject, type ProjectStats } from '@/services/projects';
import { getTechnicalTrend, type TechnicalTrendPoint } from '@/services/research';
import type { ProjectDetail } from '@/services/types';

/**
 * PJ01 — Project overview.
 *
 * design_plan.md §4.3 and the client/project overview layout family (§4):
 * "Context/lead/status, decision-needed panel, evidence/result cards, work
 * commitments, recent report/message; **each number links to its scoped
 * evidence**; unavailable target widgets remain absent or explicitly
 * unavailable."
 *
 * The two rules this page obeys that are easy to get wrong elsewhere:
 *
 *  1. **Every figure links to the run it came from.** A score with no route
 *     back to its evidence is an assertion, not a measurement.
 *  2. **Missing capabilities are named, not faked.** The plan/cycle/approval
 *     widgets in §3.2's target layout need G06/G10 data that this deployment
 *     does not have yet, so they render as explicit "not available" rows
 *     rather than as empty cards that look like real zeroes.
 *
 * `ProjectDetail` carries no score field today — only counts of artifacts that
 * exist — so the headline tiles below are artifact counts, not scores, and this
 * page does not invent a score tile from them.
 *
 * The score history is different: it is a **measured series** read from the
 * technical-audit trend route, one point per scored run, exactly what that run
 * recorded. It is not derived from the project record, and when no run has been
 * scored the section says so rather than plotting a zero.
 */
export default function ProjectOverviewPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<(ProjectDetail & { stats: ProjectStats }) | null>(null);
  const [trend, setTrend] = useState<TechnicalTrendPoint[] | null>(null);
  const [trendError, setTrendError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setTrendError(null);
        setProject(await getProject(projectId, { signal }));

        // A read of stored runs; it starts nothing (§4 audit-hub contract).
        // Read separately so a failed history read cannot hide the project
        // itself, and cannot be mistaken for "this project has no scores".
        try {
          setTrend((await getTechnicalTrend(projectId, { signal, limit: 30 })).history);
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
          setTrend(null);
          setTrendError(toApiError(caught));
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
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 rounded-xl" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const setupFailed = project.onboardingStatus === 'failed';

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

      {/*
        Artifact counts — what evidence actually exists for this project. Each
        is a link into the screen that holds it, per §4's "each number links to
        its scoped evidence".
      */}
      <section aria-labelledby="evidence-heading" className="space-y-3">
        <h2 id="evidence-heading" className="text-subsection font-semibold tracking-tight">
          Evidence on file
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Technical audits"
            value={project.stats.technicalAudits}
            unit="runs"
            provenance="measured"
            runHref={`/projects/${project.id}/research/website`}
          />
          <MetricTile
            label="Classified gaps"
            value={project.stats.gaps}
            unit="gaps"
            provenance="measured"
            runHref={`/projects/${project.id}/priorities`}
          />
          <MetricTile
            label="Brand entities"
            value={project.stats.entities}
            unit="entities"
            provenance="measured"
            runHref={`/projects/${project.id}/research/entities`}
          />
          <MetricTile
            label="Reports"
            value={project.stats.reports}
            unit="reports"
            provenance="measured"
            runHref={`/projects/${project.id}/reports`}
          />
        </div>
        <p className="text-meta text-muted-foreground">
          Counts of what has been collected. A count of zero means nothing has
          run yet — it is not a measured result of zero.
        </p>
      </section>

      {/*
        §4's overview family asks for result cards whose numbers link back to
        their evidence. A score with no route to the run that produced it is an
        assertion, so the series links to the audit hub and its own table names
        the target each run audited — the comparison key that breaks the line.
      */}
      <section aria-labelledby="score-history-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="score-history-heading" className="text-subsection font-semibold tracking-tight">
            Technical score across runs
          </h2>
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${project.id}/research/website`}>Open website health</Link>
          </Button>
        </div>
        <Card>
          <CardContent className="pt-6">
            {trendError ? (
              <ErrorState
                error={trendError}
                layout="inline"
                onRetry={() => void load()}
                preserveNotice="The project itself was read successfully; only the score history failed."
              />
            ) : (
            <TechnicalScoreHistory
              history={trend ?? []}
              emptyState={
                <EmptyState
                  variant="not-measured"
                  subject="a technical score history"
                  prerequisite="a technical audit has to run and finish with a score before there is a series to draw."
                  action={{
                    label: 'Go to website health',
                    href: `/projects/${project.id}/research/website`,
                  }}
                />
              }
              note="The series is read from the technical-audit trend route — one point per scored run. The project record itself carries no score, so nothing here is inferred from the artifact counts above."
            />
            )}
          </CardContent>
        </Card>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Recurring collection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-table">
              <CalendarCheck
                aria-hidden="true"
                className={
                  project.stats.scheduleActive
                    ? 'h-4 w-4 text-success'
                    : 'h-4 w-4 text-muted-foreground'
                }
              />
              {project.stats.scheduleActive ? (
                <span>Scheduled technical audits are running</span>
              ) : (
                <span className="text-muted-foreground">
                  No recurring audit is scheduled for this project
                </span>
              )}
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${project.id}/monitoring`}>
                Monitoring &amp; cadence
                <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Project details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-table">
            <DetailRow label="Domain">
              <span className="font-mono text-meta">{project.domain}</span>
            </DetailRow>
            {project.category ? (
              <DetailRow label="Category">{project.category}</DetailRow>
            ) : null}
            {project.timezone ? (
              <DetailRow label="Reporting timezone">{project.timezone}</DetailRow>
            ) : null}
            <DetailRow label="Created">
              <Timestamp value={project.createdAt} dateOnly />
            </DetailRow>
          </CardContent>
        </Card>
      </div>

      {/*
        §4: "unavailable target widgets remain absent or explicitly
        unavailable." These four surfaces are specified in §3.2's target layout
        but depend on packages that are not deployed here yet, so they are
        named as unavailable rather than rendered as empty cards.
      */}
      <section aria-labelledby="planned-heading" className="space-y-3">
        <h2 id="planned-heading" className="text-subsection font-semibold tracking-tight">
          Planned work
        </h2>
        <Card>
          <CardContent className="py-4">
            <ul className="space-y-2 text-table text-muted-foreground">
              <UnavailableRow icon={Target} label="Priorities and roadmap" />
              <UnavailableRow icon={ListChecks} label="Cycle commitments and work items" />
              <UnavailableRow icon={FileText} label="Pending approvals" />
            </ul>
            <p className="mt-3 text-meta text-muted-foreground">
              These need the engagements and approvals work (design_plan G06 and
              G10). They are shown here so the gap is visible rather than
              mistaken for “nothing outstanding”.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function UnavailableRow({
  icon: Icon,
  label,
}: {
  icon: typeof Target;
  label: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 opacity-60" />
      <span>{label}</span>
      <span className="ml-auto rounded-full bg-unmeasured-subtle px-2 py-0.5 text-meta text-unmeasured-foreground">
        Not available yet
      </span>
    </li>
  );
}
