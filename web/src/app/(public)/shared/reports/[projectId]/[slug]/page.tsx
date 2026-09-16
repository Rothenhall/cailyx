'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { ExternalLink, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/patterns/ErrorState';
import { PublicShell } from '@/components/layouts/PublicShell';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { useUrlState } from '@/hooks/useUrlState';
import { ApiError } from '@/lib/api';
import { resolveSharedReport, sharedReportUrl, type SharedReportView } from '@/services/shared';

/**
 * PB01 — Shared report.
 *
 * design_plan.md §4.1: *"Restricted/public resolution, executive/detailed HTML,
 * source date, print"*, in the Reports layout family (§4): reading-first, cover
 * and period, print action.
 *
 * This page is opened by somebody who is not signed in and who may not be a
 * client, so it does three things and no more:
 *
 *  1. **Resolves the link before framing it.** The report is served as HTML by
 *     the backend, and a request for a private or nonexistent report answers
 *     the same 404. Rendering a frame first would show that error page as if it
 *     were the report, so resolution is checked first and both cases render the
 *     same neutral state — a missing report and one that is not yours are
 *     deliberately indistinguishable (§4.1, §10.4).
 *
 *  2. **Frames the HTML rather than injecting it.** §10.5 forbids trusting
 *     fetched markup: the report is displayed in a sandboxed, separate document
 *     and never inserted into this app's DOM, where its styles and any embedded
 *     content would become part of the application. The frame is served
 *     same-origin by the session proxy, which is what makes the print action
 *     work — the markup itself is the backend's own template, and its
 *     interpolated values are escaped there.
 *
 *  3. **Never reads live data.** The frame's document is the stored snapshot.
 *     Nothing here re-runs an audit or re-derives a figure, and the shell's
 *     footer already says so.
 *
 * The honest limit: this link carries the snapshot's own generation date (in the
 * document footer), not its per-source capture dates. Those live in the
 * report's pinned evidence manifest, which is not part of the public projection.
 * That is stated on the page rather than left for a reader to assume the dates
 * are equivalent.
 */
export default function SharedReportPage() {
  return (
    <PublicShell contextLabel="Shared report">
      <Suspense fallback={<SharedReportSkeleton />}>
        <SharedReport />
      </Suspense>
    </PublicShell>
  );
}

/** Stable reference — `useUrlState` decodes only declared keys. */
const VIEW_DEFAULTS = { view: 'executive' };

function SharedReport() {
  const params = useParams<{ projectId: string; slug: string }>();
  const { projectId, slug } = params;

  const [state, setState] = useUrlState(VIEW_DEFAULTS);
  const view: SharedReportView = state.view === 'detailed' ? 'detailed' : 'executive';

  const [resolved, setResolved] = useState<boolean | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setResolved(null);
        setResolved(await resolveSharedReport(projectId, slug, view, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({
                kind: 'unknown',
                status: 0,
                message: 'The shared report could not be opened.',
                body: caught,
              }),
        );
      }
    },
    [projectId, slug, view],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return <ErrorState error={error} onRetry={() => void load()} />;
  }

  if (resolved === false) {
    return (
      <ErrorState
        // Not a fetch failure: the server answered, and its answer was "no".
        // A private report and a report that never existed produce this same
        // page, so the link cannot be used to discover which reports exist.
        error={
          new ApiError({
            kind: 'not-found',
            status: 404,
            message: 'This link does not open a report.',
          })
        }
        notFoundReason="missing-or-private"
      />
    );
  }

  if (resolved === null) return <SharedReportSkeleton />;

  const frameSrc = sharedReportUrl(projectId, slug, view);

  return (
    <div className="space-y-6">
      {/* No run/version is knowable here: the public projection does not
          expose the report's identity beyond what the document itself shows,
          so the banner carries the frozen-snapshot notice and nothing it
          cannot substantiate. */}
      <ScopeBanner scope={{ mode: 'snapshot', snapshotLabel: 'Released report' }} />

      {/* The view toggle is part of the copied link, so a reader who sends
          "?view=detailed" sends the detailed view. */}
      <Tabs
        value={view}
        onValueChange={(next) =>
          setState({ view: next === 'detailed' ? 'detailed' : 'executive' })
        }
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="executive">Executive</TabsTrigger>
            <TabsTrigger value="detailed">Detailed</TabsTrigger>
          </TabsList>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Same-origin frame, so the print dialog can be driven
                // directly. If a browser refuses, the new-tab link is the
                // fallback and is offered beside it.
                frameRef.current?.contentWindow?.print();
              }}
            >
              <Printer aria-hidden="true" className="mr-2 h-4 w-4" />
              Print
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={frameSrc} target="_blank" rel="noreferrer noopener">
                <ExternalLink aria-hidden="true" className="mr-2 h-4 w-4" />
                Open in a new tab
              </a>
            </Button>
          </div>
        </div>

        {/*
          One frame per view, and Radix mounts only the active one — so there is
          never a hidden second copy of the report on the page. Both point at
          the same backend document with a different `?view`.

          The frame is a separate document and is never inserted into this app's
          DOM (§10.5). `allow-same-origin` is what keeps it readable for the
          print action; the markup is this application's own report template,
          which escapes every interpolated value.
        */}
        {(['executive', 'detailed'] as const).map((each) => (
          <TabsContent key={each} value={each}>
            <iframe
              ref={frameRef}
              src={sharedReportUrl(projectId, slug, each)}
              title={each === 'executive' ? 'Shared report — executive view' : 'Shared report — detailed view'}
              sandbox="allow-same-origin allow-popups"
              className="h-[80vh] w-full rounded-xl border border-border bg-surface"
            />
          </TabsContent>
        ))}
      </Tabs>

      <section className="space-y-2 text-table text-muted-foreground">
        <h2 className="text-table font-medium text-foreground">About this link</h2>
        <p>
          This is the version that was released. It is a frozen snapshot: later
          audits and later runs do not change it, and a newer report is a separate
          document.
        </p>
        <p>
          The document carries its own generation date. It does not carry
          per-source capture dates — those are recorded in the report&apos;s
          internal evidence manifest, which is not part of the public projection.
          Treat the generation date as when the document was assembled, not as the
          end of the period its figures cover.
        </p>
        <p>
          If this page does not open a report for you, the link may have been
          turned off or the address may be wrong. Ask whoever sent it for a
          current one.
        </p>
      </section>
    </div>
  );
}

function SharedReportSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-[60vh] w-full rounded-xl" />
    </div>
  );
}
