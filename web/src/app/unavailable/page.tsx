import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * PB05 — Unavailable.
 *
 * The 503 case from §10.4: "provider/config unavailable", and §3.5
 * "Credentials configured but runtime unverified" → "Configured; last
 * successful run unknown."
 *
 * Kept separate from the generic error page because the reader's next action
 * differs: this is a provider outage or missing configuration, not their
 * mistake and not a permission problem.
 */
export default function UnavailablePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
          Temporarily unavailable
        </p>
        <h1 className="mt-3 text-title font-semibold tracking-tight">
          This service is not available right now
        </h1>
        <p className="mt-2 text-table text-muted-foreground">
          An external provider this page depends on is not responding, or its
          credentials have not been set up on this deployment. Your data has not
          been affected.
        </p>
        <p className="mt-2 text-table text-muted-foreground">
          Retrying immediately will usually give the same result. Check the
          service connections page for the current state before trying again.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/ops/admin/connections">Service connections</Link>
          </Button>
          <Button asChild>
            <Link href="/ops">Back to Today</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
