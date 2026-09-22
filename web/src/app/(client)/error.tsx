'use client';

import { useEffect } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Render-error boundary for the client portal.
 *
 * The screens already handle *data* failures through `ErrorState`, but nothing
 * caught an exception thrown while rendering — those fell through to Next's
 * overlay in development and a blank page in production.
 *
 * The copy deliberately says nothing about what broke. A client is not the
 * audience for a stack trace, and §10.5 keeps server detail out of the portal;
 * the message is logged for the console instead.
 */
export default function ClientPortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[client-portal] render error', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-reading px-4 py-10">
      <Card>
        <CardContent className="space-y-4 py-8 text-center">
          <div className="space-y-1.5">
            <h1 className="text-subsection font-semibold">This page could not be displayed</h1>
            <p className="text-table text-muted-foreground">
              Something went wrong while rendering it. Your data is unaffected.
            </p>
          </div>
          <Button size="sm" onClick={reset}>
            <RotateCcw aria-hidden="true" className="mr-2 h-4 w-4" />
            Try again
          </Button>
          {error.digest ? (
            <p className="text-meta text-muted-foreground">
              Reference <span className="font-mono">{error.digest}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
