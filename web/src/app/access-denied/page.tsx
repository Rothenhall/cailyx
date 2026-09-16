import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * PB05 — Access denied.
 *
 * §3.5 "Insufficient role" requires: "Explain restricted action and permitted
 * path; do not repeatedly refresh on 403." So this page explains what is
 * restricted and offers a way forward, and it deliberately performs **no
 * data fetch** — there is nothing here to retry.
 *
 * It also does not say *why* access was denied beyond the role, because
 * distinguishing "not yours" from "does not exist" would leak the existence of
 * other clients' resources.
 */
export default function AccessDeniedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
          Access denied
        </p>
        <h1 className="mt-3 text-title font-semibold tracking-tight">
          You do not have access to this
        </h1>
        <p className="mt-2 text-table text-muted-foreground">
          This may be another team&rsquo;s client or project, or it may need a
          role you do not hold. Nothing has been changed.
        </p>
        <p className="mt-2 text-table text-muted-foreground">
          If you need it, ask an administrator to grant you access rather than
          trying again — repeating the request will not change the result.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/ops">Back to Today</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
