'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileText, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { onboardingStatusTone } from '@/lib/status-tones';

import { listPortalProjects, listPortalReports, type PortalReportSummary } from '@/services/portal';
import type { PortalProject } from '@/services/types';

/** Day-1 pipeline progress, phrased for a client rather than an operator. */
function setupLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Ready';
    case 'running':
      return 'Setting up';
    case 'failed':
      return 'Needs attention';
    default:
      return 'Setup not started';
  }
}


/**
 * CP01 — Client home.
 *
 * design_plan.md §4.5 and §3.2 both describe the target Home as having cycle,
 * approval and delivered-work widgets. §3.2 then states the constraint
 * directly: *"The cycle, approval counts, and delivered-work widgets above
 * require extensions. The initial supported client Home uses project status,
 * latest report, and messages with equally clear empty states."*
 *
 * That is exactly what this page is. It shows the three things the backend
 * actually supports today, and it does not render a cycle count or a
 * "work delivered" number it cannot substantiate.
 *
 * §2.3 also says a one-project client should land in that project rather than
 * a portfolio. That redirect happens here, once, after the project list loads —
 * a client with exactly one project never sees this page.
 */
export default function ClientHomePage() {
  const router = useRouter();

  const [projects, setProjects] = useState<PortalProject[] | null>(null);
  const [reports, setReports] = useState<PortalReportSummary[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const [projectList, reportList] = await Promise.all([
        listPortalProjects({ signal }),
        listPortalReports({ signal }),
      ]);
      setProjects(projectList);
      setReports(reportList);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // §2.3 — one-project clients skip the portfolio entirely.
  useEffect(() => {
    if (projects?.length === 1) {
      router.replace(`/client/projects/${projects[0].id}`);
    }
  }, [projects, router]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Your workspace" />
        <ErrorState error={error} onRetry={() => void load()} showServerMessage={false} />
      </div>
    );
  }

  if (!projects || !reports) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Your workspace" />
        <EmptyState variant="no-projects" audience="client" />
      </div>
    );
  }

  const latestReport = reports[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your workspace"
        context="Visibility in search and AI answers, and what we are doing about it."
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Your projects</CardTitle>
          <span className="text-meta text-muted-foreground">{projects.length}</span>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/client/projects/${project.id}`}
                  className="group flex items-center justify-between gap-4 py-3 transition-colors hover:bg-surface-sunken"
                >
                  <div className="min-w-0">
                    <div className="truncate text-table font-medium">{project.name}</div>
                    {project.domain ? (
                      <div className="truncate font-mono text-meta text-muted-foreground">
                        {project.domain}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {/*
                      `onboardingStatus` is day-1 pipeline progress, not the
                      engagement lifecycle — the portal route does not send the
                      latter. Labelled "Setup" so it is not mistaken for what the
                      client has bought.
                    */}
                    <StatusPill
                      label={setupLabel(project.onboardingStatus)}
                      tone={onboardingStatusTone(project.onboardingStatus)}
                    />
                    {typeof project.latestScore === 'number' ? (
                      // §4.5: the meaning of this number is visible text, not
                      // a `title` only — and §3.4 forbids a score reading as
                      // account health, so it names its source: the latest
                      // report, not the state of the engagement.
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-meta text-muted-foreground">Report score</span>
                        <span className="w-10 text-right text-table font-semibold tabular-nums">
                          {project.latestScore}
                        </span>
                      </span>
                    ) : (
                      // §3.5 — never measured is not a zero score.
                      <span className="text-meta text-muted-foreground">Not measured yet</span>
                    )}
                    <ArrowRight
                      aria-hidden="true"
                      className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Latest report</CardTitle>
          </CardHeader>
          <CardContent>
            {latestReport ? (
              <div className="space-y-3">
                <div>
                  <div className="text-table font-medium">{latestReport.title}</div>
                  <div className="mt-0.5 text-meta text-muted-foreground">
                    <Timestamp value={latestReport.createdAt} dateOnly />
                  </div>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/client/reports/${latestReport.slug}`}>
                    <FileText aria-hidden="true" className="mr-2 h-4 w-4" />
                    Open report
                  </Link>
                </Button>
              </div>
            ) : (
              /*
                §3.5 — two distinct copies for this state, and the difference
                matters. "Being prepared" is a claim about a run existing; the
                backend does not expose a pending-run signal here, so the honest
                variant is `runExists: false`.
              */
              <EmptyState variant="no-reports" runExists={false} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Messages</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-table text-muted-foreground">
              Ask a question or reply to your delivery team. Everything you send
              is answered in one shared thread.
            </p>
            <Button asChild size="sm" variant="outline" className="mt-3">
              <Link href="/client/messages">
                <MessageSquare aria-hidden="true" className="mr-2 h-4 w-4" />
                Open messages
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
