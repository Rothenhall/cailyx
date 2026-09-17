'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ReportDigitalPerformanceSection, ReportPlanProgressSection } from '@/services/reports';

/**
 * The frozen score-family and plan sections of a **released** report (§14.5
 * items 2 and 8, §14.6, P15).
 *
 * ## Why these render from the snapshot and not from the live score
 *
 * §14.6: *"A released report's score, breakdown and figures must stay identical
 * after later live-score updates and after a new draft revision is created."*
 * Everything here therefore comes out of `ReportRevision.snapshot` — written
 * once at review-lock time — and this component never calls the live score
 * read. If it did, a report released in September would quietly start showing
 * October's numbers, which is the single failure the whole release model
 * exists to prevent.
 *
 * ## Telling the two numbers apart, in the reader's words
 *
 * The live Overview says *"Live score, updated <date>"*. A released report says
 * *"As released in the <Month> report"*, and this component renders that
 * sentence (`releasedLabel`, composed by the server) above the figure together
 * with the sentence saying the figure does not move. Two numbers that look
 * alike should never be confusable, so the label travels with the data rather
 * than being written by the screen.
 *
 * ## Absent is not empty, and neither is zero
 *
 * `null` means the section is not part of this release (the revision predates
 * P15) and is said in words. A frozen `incomplete` run carries no total at all
 * rather than a partial sum (§5.3), and an unmeasured bucket shows its state
 * and its reasons — never a substituted `0`.
 *
 * These components deliberately carry **no drilldown links**: a released report
 * is a document, and a link from a frozen figure into the live screen would
 * invite exactly the confusion the label exists to remove. The one link out is
 * a plain "see the live figure" pointer, offered by the caller.
 */

export function FrozenScoreSection({
  section,
  releasedLabel,
  liveHref,
  liveNote,
}: {
  section: ReportDigitalPerformanceSection | null;
  /** The server's sentence: "As released in the September report". */
  releasedLabel: string;
  /** Where the live figure lives, when the caller knows. */
  liveHref?: string | null;
  liveNote?: string;
}) {
  if (!section) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Results in this report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-table text-muted-foreground">
          <p>
            This release does not carry a results breakdown. Reports released before the breakdown
            became part of reports do not have one — nothing here is an empty result or a zero.
          </p>
          {liveHref ? (
            <p>
              <Link href={liveHref} className="text-primary underline underline-offset-4">
                See the live figure
              </Link>
              {liveNote ? ` — ${liveNote}` : null}
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const measured = section.status === 'complete' && section.total !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Results in this report</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The live/report distinction, with the server's own label. */}
        <p className="text-meta text-muted-foreground">
          {releasedLabel} — these figures are the ones this report was released with, and they do not
          change when the live score is recalculated.
        </p>

        <div className="flex flex-wrap items-end gap-6">
          <div>
            <div className="text-meta text-muted-foreground">{section.scoreName}</div>
            {measured ? (
              <div className="mt-1 text-kpi font-semibold tabular-nums">
                {formatNumber(section.total as number)}
              </div>
            ) : (
              <div className="mt-1 text-subsection font-medium text-unmeasured-foreground">
                {section.status === 'none'
                  ? 'No score had been calculated yet'
                  : 'The score was not complete'}
              </div>
            )}
          </div>
          <div className="min-w-0 text-meta text-muted-foreground">
            {section.runAt ? (
              <p>
                Measured <Timestamp value={section.runAt} dateOnly />
              </p>
            ) : null}
            <p>
              Frozen into this release <Timestamp value={section.frozenAt} dateOnly />
            </p>
          </div>
        </div>

        {section.evidenceCoverage !== null ? (
          <p className="text-meta text-muted-foreground">{section.coverageMeaning}</p>
        ) : null}

        {/* §5.3: a missing total is explained, never merely absent. */}
        {!measured && section.missingAreas.length > 0 ? (
          <div className="text-table">
            <p className="font-medium text-foreground">What was still missing</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {section.missingAreas.map((area) => (
                <li key={area}>{area}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {section.buckets.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {section.buckets.map((bucket) => {
              const bucketMeasured = bucket.state === 'measured' && bucket.value !== null;
              return (
                <div key={bucket.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-table font-medium text-foreground">{bucket.label}</p>
                    <span className="text-meta text-muted-foreground">{bucket.weight}% of the score</span>
                  </div>
                  {bucketMeasured ? (
                    <span className="mt-1 block text-subsection font-semibold tabular-nums">
                      {formatNumber(bucket.value as number)}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'mt-1 block text-table font-medium',
                        // A missing measurement is not a failure and never a
                        // danger colour (§3.5 "empty is not zero").
                        bucket.state === 'failed' ? 'text-warning-foreground' : 'text-unmeasured-foreground',
                      )}
                    >
                      {notMeasuredLabel()} — {bucket.stateLabel.toLowerCase()}
                    </span>
                  )}
                  {bucket.windowStart || bucket.windowEnd ? (
                    <p className="mt-1 text-meta text-muted-foreground">
                      <Timestamp value={(bucket.windowStart ?? bucket.windowEnd) as string} dateOnly />
                      {bucket.windowStart && bucket.windowEnd ? (
                        <>
                          {' – '}
                          <Timestamp value={bucket.windowEnd} dateOnly />
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {!bucketMeasured && bucket.missingReasons.length > 0 ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-meta text-muted-foreground">
                      {bucket.missingReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                  {bucket.sources.length > 0 ? (
                    <p className="mt-1 text-meta text-muted-foreground">
                      From{' '}
                      {bucket.sources
                        .map((source) => (source.ageDays !== null ? `${source.label} (${source.ageDays}d old)` : source.label))
                        .join(', ')}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* §5.1: the areas deliberately left out of the score are a decision to
            report, and they belong here rather than as cards without numbers. */}
        {section.excludedFromScore.length > 0 ? (
          <div className="text-meta text-muted-foreground">
            <p className="font-medium text-foreground">Not part of this score</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {section.excludedFromScore.map((entry) => (
                <li key={entry.key}>
                  {entry.label}
                  {entry.reason ? ` — ${entry.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* The calculation's identity is a details line, not a headline (§5.5):
            "methodology version" is staff vocabulary, and the client's sentence
            above already explains what the number is. */}
        <p className="text-meta text-muted-foreground">
          Calculation set {section.methodology.version}
          {section.methodology.label ? ` (${section.methodology.label})` : ''}
          {section.methodology.weightsApproved
            ? ''
            : ' — the weighting was still a proposal when this report was released'}.
        </p>

        {liveHref ? (
          <p className="text-meta text-muted-foreground">
            <Link href={liveHref} className="text-primary underline underline-offset-4">
              See the live figure
            </Link>
            {liveNote ? ` — ${liveNote}` : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function FrozenPlanProgressSection({
  section,
  releasedLabel,
}: {
  section: ReportPlanProgressSection | null;
  releasedLabel: string;
}) {
  if (!section) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Plan progress in this report</CardTitle>
        </CardHeader>
        <CardContent className="text-table text-muted-foreground">
          This release does not carry plan progress — reports released before it became part of
          reports do not have it. That is not the same as nothing having been completed.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Plan progress in this report</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-table font-medium text-foreground">{section.label}</p>
        <p className="text-meta text-muted-foreground">
          {releasedLabel} — this is the position at release, not the position today.
        </p>

        {section.commitments.length > 0 ? (
          <ul className="divide-y divide-border">
            {section.commitments.map((commitment) => (
              <li key={commitment.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block text-table">{commitment.title}</span>
                  <span className="block text-meta text-muted-foreground">
                    {commitment.workstream} · {commitment.progressLabel}
                  </span>
                </span>
                {commitment.targetDate ? (
                  <span className="text-meta text-muted-foreground">
                    Target <Timestamp value={commitment.targetDate} dateOnly />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <p className="text-meta text-muted-foreground">
          Frozen into this release <Timestamp value={section.frozenAt} dateOnly />
          {section.windowStart && section.windowEnd ? (
            <>
              {' · the plan window it covers ran '}
              <Timestamp value={section.windowStart} dateOnly /> – <Timestamp value={section.windowEnd} dateOnly />
            </>
          ) : null}
          .
        </p>
      </CardContent>
    </Card>
  );
}
