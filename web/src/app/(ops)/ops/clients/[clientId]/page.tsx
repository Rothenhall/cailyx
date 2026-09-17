'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, Mail, User, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/patterns/PageHeader';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber } from '@/lib/format';
import {
  clientStatusLabel,
  clientStatusTone,
  onboardingStatusTone,
  projectStatusLabel,
  projectStatusTone,
} from '@/lib/status-tones';
import { getClient } from '@/services/clients';
import type { ClientDetail, ProjectSummary } from '@/services/types';

/**
 * OP04 — Client overview.
 *
 * design_plan.md §4.2's client/project overview contract: "Contact/lead/status,
 * project rows, separate delivery and outcome indicators, last message, open
 * risks."
 *
 * The "separate delivery and outcome" rule is the one that shapes this page.
 * Whether the work is being delivered on time and whether it is producing
 * results are different questions with different evidence, and combining them
 * into one number would hide exactly the case that matters — a client where
 * delivery is fine and outcomes are flat.
 *
 * Project status shown here is the **engagement lifecycle**
 * (`scorecard | diagnostic | sprint | retainer | archived`), and onboarding
 * progress is shown separately because the two are orthogonal: a project can be
 * `running` its day-1 pipeline while already being a `retainer`.
 */
export default function ClientOverviewPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params.clientId;

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setClient(await getClient(clientId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }]}
          title="Client"
        />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!client) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }, { label: client.name }]}
        title={client.name}
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {client.contactName ? (
              <span className="inline-flex items-center gap-1.5">
                <User aria-hidden="true" className="h-3.5 w-3.5" />
                {client.contactName}
              </span>
            ) : null}
            {client.contactEmail ? (
              <span className="inline-flex items-center gap-1.5">
                <Mail aria-hidden="true" className="h-3.5 w-3.5" />
                <a
                  href={`mailto:${client.contactEmail}`}
                  className="underline-offset-4 hover:underline"
                >
                  {client.contactEmail}
                </a>
              </span>
            ) : null}
          </span>
        }
        primaryAction={{
          label: 'Add project',
          href: `/ops/clients/${client.id}/projects/new`,
        }}
        secondaryActions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/ops/clients/${client.id}/messages`}>Messages</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/ops/clients/${client.id}/access`}>Access</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/ops/clients/${client.id}/settings`}>Settings</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-subsection">Projects</CardTitle>
            <span className="text-meta text-muted-foreground">
              {formatNumber(client.projects.length)}
            </span>
          </CardHeader>
          <CardContent>
            {client.projects.length === 0 ? (
              <EmptyState
                variant="no-projects"
                audience="operator"
                onCreate={() => {
                  window.location.href = `/ops/clients/${client.id}/projects/new`;
                }}
              />
            ) : (
              <ul className="divide-y divide-border">
                {client.projects.map((project) => (
                  <li key={project.id}>
                    <ProjectRow project={project} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Account</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-table">
              <Field label="Status">
                <StatusPill label={clientStatusLabel(client.status)} tone={clientStatusTone(client.status)} />
              </Field>
              <Field label="Owner">
                {client.ownerUserId ? (
                  <span className="inline-flex items-center gap-1.5">
                    <UserCheck aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
                    Assigned
                  </span>
                ) : (
                  // §3.5 — an unassigned client is a real, actionable state,
                  // not a blank cell.
                  <span className="text-muted-foreground">No owner assigned</span>
                )}
              </Field>
              <Field label="Client since">
                <Timestamp value={client.createdAt} dateOnly />
              </Field>
            </CardContent>
          </Card>

          {client.notes ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">Internal notes</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Operator-only surface. Never rendered on a client route. */}
                <p className="whitespace-pre-wrap text-table text-muted-foreground">
                  {client.notes}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const onboardingIncomplete =
    project.onboardingStatus === 'running' || project.onboardingStatus === 'failed';

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group flex items-center justify-between gap-4 py-3 transition-colors hover:bg-surface-sunken"
    >
      <div className="min-w-0">
        <div className="truncate text-table font-medium">{project.name}</div>
        <div className="truncate text-meta text-muted-foreground">{project.domain}</div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/*
          Delivery indicator, kept separate from any outcome number. Onboarding
          progress is orthogonal to the engagement lifecycle, so a project can
          legitimately be a retainer whose day-1 pipeline is still running.
        */}
        {onboardingIncomplete ? (
          <StatusPill
            tone={onboardingStatusTone(project.onboardingStatus ?? 'pending')}
            label={
              project.onboardingStatus === 'failed'
                ? 'Setup failed'
                : `Setting up${project.onboardingStep ? `: ${project.onboardingStep}` : ''}`
            }
          />
        ) : null}

        <StatusPill label={projectStatusLabel(project.status)} tone={projectStatusTone(project.status)} />

        {/*
          Score is absent when never measured — never rendered as 0.
          §3.4: "A project performance score can be a secondary detail, but
          never confuse it with account health or delivery completion." A bare
          number sitting next to a setup pill and a lifecycle pill is exactly
          that confusion, so the number carries its own label. This is the same
          wording the Clients list uses for the same column.
        */}
        {typeof project.score === 'number' ? (
          <span className="flex items-baseline gap-1.5">
            <span className="text-meta text-muted-foreground">Project score</span>
            <span className="w-10 text-right text-table font-semibold tabular-nums">
              {formatNumber(project.score)}
            </span>
          </span>
        ) : (
          <span className="text-right text-meta text-muted-foreground">Not measured</span>
        )}

        <ArrowRight
          aria-hidden="true"
          className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
    </Link>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
