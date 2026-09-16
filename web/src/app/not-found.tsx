import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * PB05 — Not found.
 *
 * design_plan.md §4.1 specifies a "neutral unknown/private resource" page.
 * The neutrality is the requirement: this page must read identically whether
 * the resource does not exist or exists but is not yours, so it cannot be used
 * to probe for which report slugs or project ids are real.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
          404
        </p>
        <h1 className="mt-3 text-title font-semibold tracking-tight">
          This page is not available
        </h1>
        <p className="mt-2 text-table text-muted-foreground">
          The link may be out of date, or the page may have been removed. If you
          followed a shared report link, ask the person who sent it to check
          whether it has expired.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/">Go to Cailyx</Link>
          </Button>
          <Button asChild>
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
