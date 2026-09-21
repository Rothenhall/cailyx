'use client';

import { useEffect, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { getOnboardingWizardState, type OnboardingWizardState } from '@/services/portal-profile';

/**
 * The per-project onboarding gate (`docs/analysis/client-portal.md`
 * §2/§11/§16/§17, Phase C2 — corrected order).
 *
 * Two earlier attempts at this gate blocked the whole portal — including the
 * Day-1 report — on EVERY state short of `done`/`waived`, matching a since-
 * corrected assumption that Google (GSC+GA4) connection had to happen before
 * the client could see anything. That is wrong: per the reviewed onboarding
 * flow diagram, the real order is confirm details -> view the report (rest
 * of the portal already open) -> connect GSC -> connect GA4 -> done.
 *
 * So this gate blocks ONLY while `Project.onboardingWizardState` reads
 * `not-started` or `confirming-details` — the span before a confirmed
 * business profile exists. The moment the client confirms their details
 * (`POST .../onboarding-wizard/confirm-details`, which advances the state to
 * `connecting-gsc`), this layout renders `children` normally: the Day-1
 * report and the rest of the client portal nav are reachable immediately.
 * `connecting-gsc` and `connecting-ga4` are NOT blocking states — the client
 * is still guided toward finishing Google-connect (a banner on the welcome
 * page reads this same state and prompts for it), but nothing here forces
 * them back into a locked wizard route to get there.
 *
 * Deliberately keyed on the PROJECT's state, never on "has this signed-in
 * user personally finished the wizard" (§17) — a colleague accepting a seat
 * invite on an already-onboarded project reads `done`/`waived`/`connecting-*`
 * immediately and is never gated, because the state this reads is
 * per-project, not per-user.
 */
const BLOCKING_STATES: ReadonlySet<OnboardingWizardState> = new Set(['not-started', 'confirming-details']);

export default function ClientProjectGateLayout({ children }: { children: React.ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const pathname = usePathname();
  const router = useRouter();

  const [state, setState] = useState<OnboardingWizardState | 'checking' | 'error'>('checking');

  const isOnboardingRoute = pathname?.endsWith('/onboarding') ?? false;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function check() {
      try {
        const result = await getOnboardingWizardState(projectId, { signal: controller.signal });
        if (cancelled) return;
        setState(result.state);
        if (BLOCKING_STATES.has(result.state) && !isOnboardingRoute) {
          router.replace(`/client/projects/${projectId}/onboarding`);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (!cancelled) setState('error');
      }
    }
    void check();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pathname]);

  // The wizard route itself always renders — it is the destination the gate
  // redirects to, and it does its own (lighter) state read.
  if (isOnboardingRoute) return <>{children}</>;

  if (state === 'checking') {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  // A failed onboarding-state read fails open to "show the page" rather than
  // permanently locking a client out of their own portal over a transient
  // network error — the backend's own ownership check still applies to every
  // route underneath, this is presentation only.
  if (state === 'error') return <>{children}</>;

  if (BLOCKING_STATES.has(state)) {
    // Redirecting — render nothing rather than flashing gated content.
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  // `connecting-gsc` | `connecting-ga4` | `done` | `waived` — the report and
  // the rest of the portal are open.
  return <>{children}</>;
}
