'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Info, Layers, Settings2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  bucketDetailHref,
  getStaffScoreRun,
  type OverviewBucketCard,
  type OverviewScorePanel,
  type OverviewSection,
  type StaffScoreRunView,
} from '@/services/overview';

/**
 * §5.1's prominent score and its applicable bucket cards, plus §5.5's
 * "How this score works" sheet — the one component all three screens use
 * (client Overview, client Results, staff Overview).
 *
 * Sharing it is the point: the client and the team must not be able to drift
 * into describing the same number differently, and §5.1's hard limits (one
 * prominent total, applicable buckets only, one sentence of explanation) are
 * enforced here rather than re-implemented per page.
 *
 * Five rules this component keeps:
 *
 *  1. **The total is the server's total, or nothing.** `total` is null whenever
 *     an applicable bucket is unmeasured; the card then says the score is not
 *     complete and names the areas that are missing. It never shows a partial
 *     sum, and never `0` for "not measured" (§5.3).
 *  2. **A bucket card is not a number when it has no number.** An unmeasured
 *     bucket renders its state and its reason, not a substituted zero.
 *  3. **A card that opens something does not complete anything** (§5.6). The
 *     only interactive element on a card is a drilldown link to the screen that
 *     owns the area, with the bucket's own period preserved.
 *  4. **Not-applicable is a decision, and it is reported in the sheet.** The
 *     excluded buckets are deliberately not drawn as cards with missing
 *     numbers.
 *  5. **The client sheet is plain English.** The headlines come from the
 *     server's explanation and contain no "rubric", no "methodology version"
 *     and no weights arithmetic; the version and the full calculation are
 *     named in the details, where staff can inspect them (§5.5).
 */
export function ScoreSummary({
  section,
  projectId,
  audience,
  staffNote,
}: {
  /** `undefined` while the overview read is still in flight. */
  section: OverviewSection<OverviewScorePanel> | undefined;
  projectId: string;
  audience: 'client' | 'operator';
  /** Staff-only line rendered under the sheet (e.g. a link to the run's owner screen). */
  staffNote?: React.ReactNode;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!section) {
    return <ScoreSummarySkeleton />;
  }

  if (section.status === 'unavailable' || !section.data) {
    // §4.5: the panel degrades, the page does not. The reason is the server's
    // safe sentence — never an exception from a provider.
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Your score</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-table text-muted-foreground">
            {section.reason ?? 'We could not load this part of your overview just now.'}
          </p>
          <p className="text-meta text-muted-foreground">
            Everything else on this page is up to date.
          </p>
        </CardContent>
      </Card>
    );
  }

  const panel = section.data;
  const sheet = (
    <HowThisScoreWorksSheet
      panel={panel}
      open={sheetOpen}
      projectId={projectId}
      audience={audience}
      staffNote={staffNote}
    />
  );

  return (
    <section aria-labelledby="score-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="score-heading" className="text-subsection font-semibold tracking-tight">
            {panel.scoreName}
          </h2>
          {/* §14.6's live/report distinction, in the server's words: this is the
              live score, updated at a date — never the released one. */}
          <p className="text-meta text-muted-foreground">{panel.liveLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm">
                How this score works
              </Button>
            </SheetTrigger>
            <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
              {sheet}
            </SheetContent>
          </Sheet>
          <Button asChild variant="ghost" size="sm">
            <Link href={panel.resultsHref}>
              View results
              <ArrowUpRight aria-hidden="true" className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            {panel.total !== null ? (
              <span className="text-kpi font-semibold text-foreground">{formatNumber(panel.total)}</span>
            ) : (
              // Smaller than the KPI size on purpose: this is a statement about
              // the absence of a number, not a headline.
              <span className="text-subsection font-medium text-unmeasured-foreground">
                {panel.status === 'none' ? 'Not calculated yet' : `Not complete — ${panel.statusLabel}`}
              </span>
            )}
            {panel.total !== null && panel.changeInTotal !== null ? (
              <span className="text-table text-muted-foreground">
                {panel.changeInTotal > 0 ? '+' : ''}
                {formatNumber(panel.changeInTotal)} points since the last comparable score
              </span>
            ) : null}
            {panel.evidenceCoverage !== null ? (
              <span className="text-meta text-muted-foreground">{panel.coverageMeaning}</span>
            ) : null}
          </div>

          {panel.status === 'none' ? <p className="text-table text-muted-foreground">{section.reason}</p> : null}

          {/* The areas with no number, named. §5.3's rule is that the missing
              total is explained, not merely absent. */}
          {panel.total === null && panel.missingAreas.length > 0 ? (
            <div className="text-table">
              <p className="font-medium text-foreground">What is still missing</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {panel.missingAreas.map((area) => (
                  <li key={area}>{area}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {panel.changeInTotal === null && panel.comparisonNote ? (
            <p className="flex items-start gap-1.5 text-meta text-warning-foreground">
              <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {panel.comparisonNote}
            </p>
          ) : null}

          {/* §5.3 rule 7: a previous complete score is its own object, named as
              "last complete", never merged into the live number. */}
          {panel.lastComplete && !panel.lastCompleteIsLatest ? (
            <p className="text-meta text-muted-foreground">
              Last complete score — <Timestamp value={panel.lastComplete.createdAt} dateOnly />
              {panel.lastComplete.total !== null ? ` (${formatNumber(panel.lastComplete.total)})` : ''}. The
              current calculation is not complete, so that is the most recent finished score.
            </p>
          ) : null}

          {!panel.weightsApproved ? (
            <p className="text-meta text-muted-foreground">
              The weighting below is still a proposal, not a signed-off rule.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {panel.buckets.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {panel.buckets.map((bucket) => (
            <BucketCard key={bucket.key} bucket={bucket} projectId={projectId} audience={audience} />
          ))}
        </div>
      ) : panel.status !== 'none' ? (
        <Card>
          <CardContent className="py-4 text-table text-muted-foreground">
            No area of this score has been measured yet.
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

/** §4.5: the placeholder is shaped like the content it replaces. */
export function ScoreSummarySkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <Skeleton className="h-32 rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * One applicable bucket (§5.1). Measured cards carry the number; everything
 * else carries its state and why, and a drilldown that opens the owning screen
 * on the same period the card describes (§5.5).
 */
function BucketCard({
  bucket,
  projectId,
  audience,
}: {
  bucket: OverviewBucketCard;
  projectId: string;
  audience: 'client' | 'operator';
}) {
  const measured = bucket.state === 'measured' && bucket.value !== null;
  const href = bucketDetailHref(projectId, bucket, audience);

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-table font-medium text-foreground">{bucket.label}</p>
        <span className="text-meta text-muted-foreground">{bucket.weight}% of the score</span>
      </div>

      {measured ? (
        <span className="text-subsection font-semibold text-foreground">{formatNumber(bucket.value as number)}</span>
      ) : (
        <span
          className={cn(
            'text-table font-medium',
            // A missing measurement is not a failure and never a danger colour
            // (§3.5 "Empty is not zero").
            bucket.state === 'failed' ? 'text-warning-foreground' : 'text-unmeasured-foreground',
          )}
        >
          {notMeasuredLabel()} — {bucket.stateLabel.toLowerCase()}
        </span>
      )}

      {bucket.windowStart || bucket.windowEnd ? (
        <p className="text-meta text-muted-foreground">
          <Timestamp value={(bucket.windowStart ?? bucket.windowEnd) as string} dateOnly />
          {bucket.windowStart && bucket.windowEnd ? (
            <>
              {' – '}
              <Timestamp value={bucket.windowEnd} dateOnly />
            </>
          ) : null}
        </p>
      ) : null}

      {!measured && bucket.missingReasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-meta text-muted-foreground">
          {bucket.missingReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {href ? (
        <Link href={href} className="mt-auto inline-flex w-fit items-center gap-1 text-meta font-medium text-primary hover:underline">
          See what is behind this
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <p className="mt-auto text-meta text-muted-foreground">No detail page is recorded for this area yet.</p>
      )}
    </Card>
  );
}

// ─── §5.5 "How this score works" ─────────────────────────────────────────────

/**
 * The sheet, in plain English: what the areas are, what makes the overall
 * number appear or not appear, and what coverage means.
 *
 * Staff get the arithmetic on top of it — the stored run, read on demand from
 * `GET /projects/:id/scores/:runId` — because §5.5 separates "explain it to the
 * client" from "let staff inspect the calculation", and neither is derived from
 * the other.
 */
function HowThisScoreWorksSheet({
  panel,
  open,
  projectId,
  audience,
  staffNote,
}: {
  panel: OverviewScorePanel;
  /**
   * Whether the sheet is showing. Not a controlled-input contract: the parent's
   * `Sheet` owns open state, and this only decides whether the staff half (an
   * on-demand read of the stored calculation) is rendered at all.
   */
  open: boolean;
  projectId: string;
  audience: 'client' | 'operator';
  staffNote?: React.ReactNode;
}) {
  const explanation = panel.howThisScoreWorks;

  return (
    <div className="space-y-5">
      <SheetHeader>
        <SheetTitle>{explanation.headline}</SheetTitle>
        <SheetDescription>
          How your {panel.scoreName} is put together, in plain terms. Nothing here is a promise about
          rankings or revenue.
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-3 text-table">
        <SheetRule title="When the overall score appears">{explanation.totalRule}</SheetRule>
        <SheetRule title="When an area has no number">{explanation.missingDataRule}</SheetRule>
        <SheetRule title="What coverage means">{explanation.coverageRule}</SheetRule>
        <SheetRule title="Comparing with an earlier score">{explanation.comparisonRule}</SheetRule>
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-table font-semibold">The areas</h3>
        <ul className="space-y-2">
          {explanation.buckets.map((bucket) => (
            <li key={bucket.key} className="rounded-md border border-border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-table font-medium">{bucket.label}</span>
                <span className="text-meta text-muted-foreground">{bucket.weight}%</span>
              </div>
              {bucket.covers.length > 0 ? (
                <p className="mt-1 text-meta text-muted-foreground">Counts: {bucket.covers.join('; ')}</p>
              ) : null}
              {bucket.excludes.length > 0 ? (
                <p className="text-meta text-muted-foreground">Does not count: {bucket.excludes.join('; ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {/* §5.1: a not-applicable decision is reported here — and only here — as
          the recorded decision it is, never as a missing number on a card. */}
      {panel.excludedFromScore.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-table font-semibold">Areas that do not apply to you</h3>
          <p className="text-meta text-muted-foreground">
            These were recorded as not applicable, so their share of the score is shared out across the
            areas that do apply. That is a decision, not missing data.
          </p>
          <ul className="space-y-1">
            {panel.excludedFromScore.map((excluded) => (
              <li key={excluded.key} className="text-meta text-muted-foreground">
                <span className="font-medium text-foreground">{excluded.label}</span>
                {excluded.reason ? ` — ${excluded.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!panel.weightsApproved ? (
        <Alert>
          <Settings2 aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>How much each area counts is not final</AlertTitle>
          <AlertDescription>{panel.approvalNote}</AlertDescription>
        </Alert>
      ) : null}

      {/* The version, in the details rather than a headline (§4.3/§5.5). */}
      <p className="text-meta text-muted-foreground">
        Calculated with calculation set {explanation.methodologyVersion}.
        {panel.runAt ? (
          <>
            {' '}
            This reading was calculated on <Timestamp value={panel.runAt} dateOnly />.
          </>
        ) : null}
      </p>

      {audience === 'operator' && panel.runId && open ? (
        <StaffScoreCalculation projectId={projectId} runId={panel.runId} />
      ) : null}

      {audience === 'operator' && panel.runId && !open ? (
        <p className="text-meta text-muted-foreground">
          The full stored calculation is shown here when this panel is open.
        </p>
      ) : null}

      {staffNote}
    </div>
  );
}

function SheetRule({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-table font-semibold">{title}</h3>
      <p className="mt-0.5 text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * Staff-only: the stored arithmetic behind the number — every bucket with its
 * weight, share, contribution, window and the reasons it has no value.
 *
 * Read on demand rather than with the page: the client never sees it, so
 * fetching it for every Overview load would be work nobody asked for. It is a
 * pure read of the stored run — opening this panel computes nothing and starts
 * nothing (§5.7).
 */
function StaffScoreCalculation({ projectId, runId }: { projectId: string; runId: string }) {
  const [run, setRun] = useState<StaffScoreRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        setError(null);
        setRun(await getStaffScoreRun(projectId, runId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError('We could not load the stored calculation for this score.');
      } finally {
        setLoading(false);
      }
    },
    [projectId, runId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="space-y-3">
      <Separator />
      <h3 className="flex items-center gap-2 text-table font-semibold">
        <Layers aria-hidden="true" className="h-4 w-4" />
        Full calculation (staff)
      </h3>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 rounded-md" />
        </div>
      ) : error ? (
        <p className="text-meta text-warning-foreground">{error}</p>
      ) : run ? (
        <div className="space-y-3 text-meta">
          <p className="text-muted-foreground">
            Run {run.family} · calculation set {run.methodology.version} · coverage {run.evidenceCoverage}% ·
            recorded <Timestamp value={run.createdAt} dateOnly />.
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {run.buckets.map((bucket) => (
              <li key={bucket.key} className="space-y-0.5 p-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-foreground">{bucket.label}</span>
                  <span className="text-muted-foreground">
                    {bucket.applicability === 'not-applicable'
                      ? 'not applicable'
                      : `${bucket.state} · weight ${bucket.weight} → ${bucket.effectiveWeight}`}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {bucket.value !== null ? `value ${formatNumber(bucket.value)}` : 'no value'} · contribution{' '}
                  {formatNumber(bucket.contribution)} · {bucket.metricVersion}
                </p>
                {bucket.applicabilityReason ? (
                  <p className="text-muted-foreground">Not applicable: {bucket.applicabilityReason}</p>
                ) : null}
                {bucket.missingReasons.length > 0 ? (
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {bucket.missingReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
