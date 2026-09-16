'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Info, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';

/**
 * CP08 — Content. **Deliberately unavailable, and it says so.**
 *
 * design_plan.md §4.5 specifies this screen as *"Shared drafts and published
 * assets, statuses, live URLs, review requests"*, with support listed as
 * "N G09/G10/G11" — a new surface. It does not exist on the backend: the
 * content module's three route groups (`content-briefs`, `growth-execution
 * assets`, `content-jobs`) are operator-only, and there is **no
 * `@ClientPortal()` controller for content anywhere in the API** (the same is
 * true of the publishing module). A screen that called them would 403.
 *
 * §4.5's closing rule is the one this page follows: *"An unsupported target
 * screen should remain a design/prototype artifact until its contracts exist; a
 * production button must lead to a real supported action or clearly labeled
 * human-assisted process."*
 *
 * So this is not an empty list pretending content was shared and then removed.
 * It names the missing capability, states what will appear here when it ships,
 * and routes the reader to the two things that *are* supported today — the
 * approval queue (where a review request actually arrives) and messages.
 *
 * The one read it makes is the project summary, so the scope banner and the
 * "not your project" case stay honest.
 */
export default function ClientContentPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<PortalProjectSummary | null | undefined>(undefined);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const projects = await listPortalProjectSummaries({ signal });
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
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
        <PageHeader title="Content" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (project === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  if (project === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" />
        <EmptyState
          variant="not-measured"
          subject="this project"
          prerequisite="It is not one of the projects on your account."
          action={{ label: 'Back to your projects', href: '/client/projects' }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Content' },
        ]}
        title="Content"
        context="Drafts and published pages your team is working on."
        secondaryActions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/client/approvals">
                <ShieldCheck aria-hidden="true" className="mr-2 h-4 w-4" />
                Approvals
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/client/messages">Messages</Link>
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Not available in this build</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <EmptyState
            variant="not-measured"
            subject="shared drafts and published assets"
            prerequisite="The client-facing content API has not been built yet. Until it is, this screen has nothing it can honestly show."
          />

          <p className="text-table text-muted-foreground">
            When it is built, this is what will appear here — for {project.domain} only:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-table text-muted-foreground">
            <li>Drafts your delivery team has explicitly shared with you, with their status.</li>
            <li>Published assets, with the live URL we verified and when we last checked it.</li>
            <li>Review requests waiting on you, with the exact version under review.</li>
          </ul>

          <Alert>
            <Info aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>What you can do today</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                A review request does not sit on this screen — it arrives as an
                approval, with the exact version it binds to and its decision
                history.
              </p>
              <p>
                Anything else, including “where has this draft got to?”, is
                answered in messages, in one thread your delivery team reads.
              </p>
            </AlertDescription>
          </Alert>

          <p className="text-meta text-muted-foreground">
            To be explicit about what this screen will never show, whatever ships:
            internal briefs, drafts not shared with you, operator notes, model cost
            or spend figures, and content belonging to another client. Those are
            excluded on the server rather than hidden by this page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
