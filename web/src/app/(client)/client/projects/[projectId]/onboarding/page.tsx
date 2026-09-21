'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, clientActionMessage, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  confirmOnboardingDetailsStep,
  getBusinessInfoOverview,
  getOnboardingWizardState,
  type BusinessInfoOverview,
  type OnboardingWizardState,
} from '@/services/portal-profile';

/**
 * C2 onboarding wizard, step 1 of 1: confirm/edit business details
 * (`docs/analysis/client-portal.md` §2, §11, §12, §16, §17).
 *
 * This route is the destination `../layout.tsx`'s gate redirects to, and it
 * blocks the rest of the portal ONLY through this step — `not-started` and
 * `confirming-details`. The moment `confirmOnboardingDetailsStep` succeeds,
 * the gate opens (state moves to `connecting-gsc`) and this page sends the
 * client straight to their project dashboard, where the Day-1 report and the
 * rest of the portal are already reachable. This corrects two earlier
 * attempts at this wizard, which kept the Google-connect steps inside this
 * same gated page — that ordering is wrong per the reviewed onboarding-flow
 * diagram; GSC/GA4 connect now happens AFTER the report is visible, guided
 * from a banner on `../welcome/page.tsx`, not from this blocking route.
 *
 * Does not reimplement business-profile editing — it links out to the
 * existing, working screen (`../business-info/page.tsx`) and only owns the
 * one transition: advancing the gate once a confirmed profile genuinely
 * exists (never on "the client clicked next" alone — the server re-checks).
 */
export default function OnboardingWizardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [state, setState] = useState<OnboardingWizardState | null>(null);
  const [overview, setOverview] = useState<BusinessInfoOverview | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, wizard, overviewResult] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getOnboardingWizardState(projectId, { signal }),
          getBusinessInfoOverview(projectId, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setState(wizard.state);
        setOverview(overviewResult);

        // Already past the confirm-details step (by anyone — §17 is
        // project-scoped, not user-scoped) — nothing left to do here. The
        // report and the rest of the portal are open; send them there.
        if (wizard.state !== 'not-started' && wizard.state !== 'confirming-details') {
          router.replace(`/client/projects/${projectId}`);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, router],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onConfirmDetails() {
    setBusy(true);
    setActionError(null);
    try {
      await confirmOnboardingDetailsStep(projectId);
      // Advances past the only blocking span — go straight to the report /
      // rest of the portal, which is open the instant this succeeds.
      router.replace(`/client/projects/${projectId}`);
    } catch (caught) {
      setActionError(
        clientActionMessage(
          caught,
          'That could not be confirmed. Review and confirm your business details below first.',
        ),
      );
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Get your portal ready" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || !state || !overview) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Confirm your business details"
        context="One quick step before you can see your Day-1 report and the rest of your portal. You'll connect Google Search Console and Analytics afterward."
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="ring-1 ring-primary">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Review what we found on {project.domain}</CardTitle>
          <StatusPill
            label={
              overview.profileState === 'confirmed'
                ? 'Confirmed'
                : overview.profileState === 'draft'
                  ? 'Draft — not yet confirmed'
                  : 'Not started'
            }
            tone={overview.profileState === 'confirmed' ? 'success' : 'warning'}
          />
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-table text-muted-foreground">
            Your description, category, services, ideal customers and competitors — pre-filled from what
            we already gathered. Correct anything that is wrong, then confirm.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/client/projects/${projectId}/business-info`}>
                Review &amp; edit details
                <ExternalLink aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
            <Button size="sm" disabled={busy || overview.profileState !== 'confirmed'} onClick={() => void onConfirmDetails()}>
              {busy ? 'Continuing…' : "I've confirmed my details, continue"}
            </Button>
          </div>
          {overview.profileState !== 'confirmed' ? (
            <p className="text-meta text-muted-foreground">
              Confirm your details on the &quot;Review &amp; edit details&quot; page before continuing.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
