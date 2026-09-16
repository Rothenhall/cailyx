'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, CalendarCheck, FileText, ListChecks, Target } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { WorkList } from '@/components/patterns/WorkRow';
import { formatNumber } from '@/lib/format';
import { onboardingStatusTone } from '@/lib/status-tones';
import { toViewWorkStatus } from '@/lib/work-mapping';
import {
  listPortalProjectSummaries,
  listPortalReports,
  type PortalProjectSummary,
  type PortalReportSummary,
} from '@/services/portal';
import {
  getPortalBusinessProfile,
  getPortalCapabilities,
  type PortalBusinessProfileResponse,
  type PortalCapabilities,
} from '@/services/portal-profile';
import { listPortalWorkItems, type PortalWorkItem } from '@/services/portal-plan';
import type { WorkItem as WorkViewItem } from '@/types';

/**
 * CP03 — Project home.
 *
 * design_plan.md §4.5: *"Selected project, agreed goals, baseline readiness,
 * current work, latest approved report."*
 *
 * The three distinctions this screen exists to keep straight:
 *
 *  1. **"Agreed" means confirmed.** A business profile is a proposal until a
 *     human confirms it, and an edit never rewrites the confirmed row — so the
 *     goals card renders the confirmed version when there is one and labels a
 *     draft as a proposal. A draft is never presented as something anyone has
 *     stood behind.
 *  2. **Baseline readiness is a measurement question, not a progress bar.** The
 *     capabilities view says what Cailyx can and cannot measure for this
 *     project and what, if anything, the client must do. An unavailable
 *     capability is named with its reason, never blurred into a percentage, and
 *     a `simulated-test` source is disclosed as fixtures rather than silently
 *     counted as available.
 *  3. **Work items carry no owner name on this surface.** The portal work DTO
 *     holds an assignee *id*, and §4.5 keeps operator and client identifiers off
 *     the client surface, so the owner column says the name is not shown here
 *     rather than inventing one.
 *
 * There is no `GET /portal/projects/:id`, so this project's own summary is read
 * from the list endpoint — which the server has already scoped to this client —
 * and selected by id. An id that is not in that list is a project that is not
 * theirs, and both that case and a genuinely unknown id render the same
 * "not available" state.
 */
export default function ClientProjectHomePage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params.projectId;

  /** `undefined` while loading; `null` when the project is not this client's. */
  const [project, setProject] = useState<PortalProjectSummary | null | undefined>(undefined);
  const [reports, setReports] = useState<PortalReportSummary[]>([]);
  const [profile, setProfile] = useState<PortalBusinessProfileResponse | null>(null);
  const [capabilities, setCapabilities] = useState<PortalCapabilities | null>(null);
  const [workItems, setWorkItems] = useState<PortalWorkItem[]>([]);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, reportList] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          listPortalReports({ signal }),
        ]);
        const found = projects.find((entry) => entry.id === projectId) ?? null;
        setProject(found);
        setReports(reportList);

        if (!found) {
          setProfile(null);
          setCapabilities(null);
          setWorkItems([]);
          return;
        }

        // The three project-scoped reads are independent: one failing must not
        // blank the others, and each has its own honest state below.
        const [profileResult, capabilitiesResult, workResult] = await Promise.allSettled([
          getPortalBusinessProfile(projectId, {}, { signal }),
          getPortalCapabilities(projectId, { signal }),
          listPortalWorkItems(projectId, { signal }),
        ]);
        if (profileResult.status === 'fulfilled') setProfile(profileResult.value);
        if (capabilitiesResult.status === 'fulfilled') setCapabilities(capabilitiesResult.value);
        if (workResult.status === 'fulfilled') setWorkItems(workResult.value);
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
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (project === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
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

  const latestReport = reports.find((report) => report.projectId === projectId) ?? null;
  const confirmedProfile = profile?.profile && !profile.profile.isDraft ? profile.profile : null;
  const draftProfile = profile?.profile?.isDraft ? profile.profile : null;
  const openWork = workItems.filter(
    (item) => item.status !== 'verified' && item.status !== 'cancelled',
  );

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{ projectName: project.name, domain: project.domain, mode: 'live' }}
      />

      <PageHeader
        breadcrumbs={[{ label: 'Your projects', href: '/client/projects' }, { label: project.name }]}
        title={project.name}
        context={<span className="font-mono text-meta">{project.domain}</span>}
        status={
          <StatusPill
            label={setupLabel(project)}
            tone={
              project.onboardingStatus ? onboardingStatusTone(project.onboardingStatus) : 'unmeasured'
            }
          />
        }
        primaryAction={{ label: 'Open the plan', href: `/client/projects/${projectId}/plan` }}
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/client/projects/${projectId}/welcome`}>Welcome checklist</Link>
          </Button>
        }
      />

      {project.onboardingStatus === 'failed' ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Setup did not finish</AlertTitle>
          <AlertDescription>
            {project.onboardingStep
              ? `Setup stopped during “${project.onboardingStep}”. Anything completed before that stage is still available, and the readiness panel says what it means for measurement.`
              : 'Setup did not complete. Anything it produced before stopping is still available, and the readiness panel says what it means for measurement.'}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Agreed goals ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-subsection">Agreed goals</CardTitle>
            {confirmedProfile?.confirmedAt ? (
              <span className="text-meta text-muted-foreground">
                Confirmed <Timestamp value={confirmedProfile.confirmedAt} dateOnly />
              </span>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {confirmedProfile ? (
              <>
                {confirmedProfile.data.goals.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-table">
                    {confirmedProfile.data.goals.map((goal) => (
                      <li key={goal}>{goal}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-table text-muted-foreground">
                    The confirmed profile does not state commercial goals yet.
                  </p>
                )}
                {confirmedProfile.data.services.length > 0 ? (
                  <p className="text-meta text-muted-foreground">
                    Services in scope: {confirmedProfile.data.services.join(', ')}
                  </p>
                ) : null}
                {confirmedProfile.data.markets.length > 0 ? (
                  <p className="text-meta text-muted-foreground">
                    Markets: {confirmedProfile.data.markets.join(', ')}
                  </p>
                ) : null}
              </>
            ) : draftProfile ? (
              <>
                <Alert>
                  <AlertTitle>Proposed, not yet agreed</AlertTitle>
                  <AlertDescription>
                    These details are drafted but nobody has confirmed them, so
                    they are a proposal rather than an agreed scope.
                  </AlertDescription>
                </Alert>
                {draftProfile.data.goals.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-table">
                    {draftProfile.data.goals.map((goal) => (
                      <li key={goal}>{goal}</li>
                    ))}
                  </ul>
                ) : null}
                <Button asChild size="sm" variant="outline">
                  <Link href={`/client/projects/${projectId}/welcome`}>Review and confirm</Link>
                </Button>
              </>
            ) : (
              <EmptyState
                variant="not-measured"
                subject="agreed goals"
                prerequisite="Your company details have not been captured yet. The welcome checklist is where that starts."
                action={{
                  label: 'Open the welcome checklist',
                  href: `/client/projects/${projectId}/welcome`,
                }}
              />
            )}
          </CardContent>
        </Card>

        {/* ── Baseline readiness ───────────────────────────────────────── */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-subsection">Baseline readiness</CardTitle>
            {capabilities ? (
              <span className="text-meta text-muted-foreground">
                {capabilities.summary.available} of {capabilities.summary.total} available
              </span>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {capabilities === null ? (
              <EmptyState
                variant="not-measured"
                subject="baseline readiness"
                prerequisite="The readiness check could not be read just now. Reload to try again."
              />
            ) : capabilities.capabilities.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="baseline readiness"
                prerequisite="No measurement capability is registered for this project yet."
              />
            ) : (
              <>
                {capabilities.capabilities.filter((entry) => entry.state === 'action-required')
                  .length > 0 ? (
                  <ul className="space-y-2">
                    {capabilities.capabilities
                      .filter((entry) => entry.state === 'action-required')
                      .map((entry) => (
                        <li key={entry.capability} className="flex items-start gap-2 text-table">
                          <Target
                            aria-hidden="true"
                            className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground"
                          />
                          <span>
                            <span className="font-medium">{entry.label}</span>
                            <span className="block text-meta text-muted-foreground">
                              {entry.clientAction ?? entry.description}
                            </span>
                          </span>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="flex items-center gap-2 text-table text-muted-foreground">
                    <CalendarCheck aria-hidden="true" className="h-4 w-4" />
                    Nothing is waiting on you for measurement.
                  </p>
                )}

                <ul className="divide-y divide-border border-t border-border pt-2">
                  {capabilities.capabilities.map((entry) => (
                    <li key={entry.capability} className="flex items-start justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="block text-table">{entry.label}</span>
                        <span className="block text-meta text-muted-foreground">
                          {entry.state === 'available'
                            ? entry.lastMeasuredAt
                              ? `Last measured ${formatMeasuredAt(entry.lastMeasuredAt)}`
                              : 'Available; no measurement recorded yet'
                            : entry.description}
                        </span>
                        {entry.dataSource === 'simulated-test' ? (
                          <span className="mt-1 block text-meta text-warning-foreground">
                            {entry.dataSourceDisclosure ??
                              'This capability is returning test fixtures rather than live data, so it is not shown as available.'}
                          </span>
                        ) : null}
                      </span>
                      <StatusPill
                        label={capabilityStateLabel(entry.state)}
                        tone={capabilityStateTone(entry.state)}
                      />
                    </li>
                  ))}
                </ul>

                <p className="text-meta text-muted-foreground">{capabilities.note}</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Latest released report ─────────────────────────────────────── */}
      <section aria-labelledby="latest-report-heading" className="space-y-3">
        <h2 id="latest-report-heading" className="text-subsection font-semibold tracking-tight">
          Latest report
        </h2>
        <Card>
          <CardContent className="py-4">
            {latestReport ? (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate text-table font-medium">{latestReport.title}</span>
                  </div>
                  <div className="mt-1 text-meta text-muted-foreground">
                    Generated <Timestamp value={latestReport.createdAt} dateOnly />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {typeof latestReport.scoreTotal === 'number' ? (
                    <span className="text-subsection font-semibold tabular-nums">
                      {formatNumber(latestReport.scoreTotal)}
                    </span>
                  ) : (
                    <span className="text-meta text-muted-foreground">Not scored</span>
                  )}
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/client/reports/${latestReport.slug}`}>
                      Open report
                      <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>
            ) : (
              /*
                §3.5 — "being prepared" is a claim about a run existing, and this
                surface carries no run signal, so the honest variant is
                runExists: false.
              */
              <EmptyState variant="no-reports" runExists={false} />
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Current work ───────────────────────────────────────────────── */}
      <section aria-labelledby="current-work-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="current-work-heading" className="text-subsection font-semibold tracking-tight">
            Current work
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/client/projects/${projectId}/plan`}>
              <ListChecks aria-hidden="true" className="mr-2 h-4 w-4" />
              Full plan and milestones
            </Link>
          </Button>
        </div>

        {workItems.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState variant="no-work" scope="project">
                <Link href="/client/messages" className="text-primary underline underline-offset-4">
                  Ask your delivery team
                </Link>{' '}
                what is planned next.
              </EmptyState>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-4">
              <WorkList
                items={openWork.map((item) => toWorkViewItem(item))}
                label="Current work"
                caption="Shared with you by your delivery team. Who each item is assigned to is not shown on this screen."
                onOpen={(item) => router.push(`/client/projects/${projectId}/work/${item.id}`)}
                emptyState={
                  <EmptyState variant="no-work" scope="project" layout="inline" />
                }
              />
            </CardContent>
          </Card>
        )}

        <p className="text-meta text-muted-foreground">
          {openWork.length} open item{openWork.length === 1 ? '' : 's'}
          {workItems.length > openWork.length
            ? ` · ${workItems.length - openWork.length} finished or cancelled item${
                workItems.length - openWork.length === 1 ? '' : 's'
              } on the plan`
            : ''}
          .
        </p>
      </section>
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

function capabilityStateLabel(state: PortalCapabilities['capabilities'][number]['state']): string {
  switch (state) {
    case 'available':
      return 'Available';
    case 'action-required':
      return 'Needs you';
    case 'not-set-up':
      return 'Not set up';
    case 'unavailable':
      return 'Unavailable';
  }
}

function capabilityStateTone(
  state: PortalCapabilities['capabilities'][number]['state'],
): StatusTone {
  switch (state) {
    case 'available':
      return 'success';
    case 'action-required':
      return 'warning';
    case 'not-set-up':
    case 'unavailable':
    default:
      // A capability that is not set up is unmeasured, not broken.
      return 'unmeasured';
  }
}

/**
 * The §3.3 work view model, built from the portal DTO.
 *
 * `owner` is deliberately not a name: the portal sends an assignee id, and this
 * surface does not render user identifiers. `evidenceHref` points at the work
 * detail screen, where the evidence actually lives — never at a guessed
 * external URL. The status vocabulary is mapped through the app's single
 * `toViewWorkStatus` so this list and every operator list agree.
 */
function toWorkViewItem(item: PortalWorkItem): WorkViewItem {
  return {
    id: item.id,
    deliverable: item.title,
    owner: 'Not shown here',
    dueDate: item.dueAt ?? undefined,
    status: toViewWorkStatus(item.status),
    blocker: item.status === 'blocked' ? (item.blockedReason ?? undefined) : undefined,
    evidenceHref: `/client/projects/${item.projectId}/work/${item.id}`,
    nextAction: undefined,
  };
}

function formatMeasuredAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'at a time that could not be read';
  return date.toLocaleDateString();
}
