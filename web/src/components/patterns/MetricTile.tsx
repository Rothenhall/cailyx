import { ArrowDownRight, ArrowUpRight, CalendarDays, ExternalLink, Info, Minus, Target } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  formatNumber,
  formatPercentagePoints,
  formatRelativePercent,
  notMeasuredLabel,
  resolveTimeZone,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ComparableBaseline, CoverageSummary, ProvenanceKind, SourceDateInfo } from '@/types';

/**
 * §10.5 "Validate outbound link schemes": a link is only rendered when the
 * target is an http(s) URL or an app-relative path, so a `javascript:` or
 * `data:` string that arrived from fetched evidence can never become a
 * clickable target.
 */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('/')) return href;
  return /^https?:\/\//i.test(href) ? href : undefined;
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * How the delta between the value and its baseline is expressed. Cailyx never
 * mixes these: a score moving 42% → 47% is "+5 pp", while the same move
 * described as "+11.9%" is a different unit entirely (§3.4).
 */
export type MetricDeltaMode = 'absolute' | 'percentage-points' | 'relative-percent';

/** Which way is good. `neutral` (the default) shows the direction of change
 *  without colouring it as an improvement or a decline, because the component
 *  cannot know that a rise in this metric is desirable. */
export type MetricDirection = 'higher-is-better' | 'lower-is-better' | 'neutral';

export interface MetricTileProps {
  /** What is being measured, e.g. "Organic clicks". */
  label: string;
  /**
   * The measured value. `null`/`undefined`/`NaN` means "never measured" and
   * renders the §3.5 copy with the `unmeasured` token — never `0`, never a
   * `danger` tone, and never a failing score.
   */
  value: number | null | undefined;
  /** Display unit, e.g. "clicks", "%", "seconds". Percent metrics are what
   *  make the delta a percentage-point change rather than a relative one. */
  unit?: string;
  /** The reporting window this value covers, e.g. "Last 28 days". */
  windowLabel?: string;
  /** The run this value came from, e.g. "AEO run 2026-09-14". */
  runLabel?: string;
  /** Internal link to that run's detail screen. */
  runHref?: string;
  /** Which source the underlying data was last captured from. */
  sourceDate?: SourceDateInfo;
  /** IANA zone for the dates shown (the engagement's reporting timezone). */
  timeZone?: string;
  /** How much of the agreed evidence returned. Rendered by `CoveragePanel`,
   *  so a tile can never imply completeness the run did not have. */
  coverage?: CoverageSummary;
  /**
   * A baseline the caller has **asserted** is methodologically comparable.
   * Typed as `ComparableBaseline` precisely so a bare number cannot be passed:
   * there is no way to express "this went up" without also saying what it went
   * up from and that the two are comparable.
   */
  baseline?: ComparableBaseline;
  /** Overrides the arithmetic used for the delta. Defaults to
   *  `percentage-points` for `%`/`pp` units and `absolute` otherwise;
   *  `relative-percent` is never inferred, it must be asked for. */
  deltaMode?: MetricDeltaMode;
  /** Whether a rise in this metric is good. Defaults to `neutral`. */
  direction?: MetricDirection;
  /** Provenance of the value. Ignored when the value is unmeasured, which is
   *  always badged `unmeasured`. */
  provenance?: ProvenanceKind;
  /** Formats the value. Replaces the number *and* the unit, so a caller that
   *  needs currency or a fixed precision owns the whole string. */
  formatValue?: (value: number) => string;
  /** Link to the scoped evidence for this number (§3.3 "evidence link"). */
  evidenceHref?: string;
  /** A caller-supplied evidence control, e.g. an `EvidenceDrawer` trigger.
   *  Takes precedence over `evidenceHref`. */
  evidence?: React.ReactNode;
  /** Prerequisite/action copy. Required reading when the value is unmeasured
   *  (§3.5 "Source never measured" pairs the label with the action). */
  note?: React.ReactNode;
  /**
   * What to say when a *previous* measurement exists but is **not** comparable
   * to this one — a changed query set, engine, window or transport.
   *
   * This is not the same as having no baseline. Without a baseline the §3.5
   * "First measurement" copy is correct; once a second run exists that copy is
   * false, yet no `ComparableBaseline` can honestly be passed either. Without
   * this prop a screen's only options are to render a delta it must not claim,
   * or to say something untrue — so this names the third state explicitly and
   * suppresses both the delta and the first-measurement line.
   *
   * Non-empty by intent: an empty string is treated as absent.
   */
  notComparableNote?: string;
  /** Renders a skeleton in place of the value while the request is in flight. */
  isLoading?: boolean;
  className?: string;
}

interface DeltaView {
  text: string;
  tone: 'improved' | 'worsened' | 'neutral';
  icon: 'up' | 'down' | 'flat';
  /** A caveat the reader needs in order to read the number correctly. */
  caveat?: string;
}

function signedNumber(value: number): string {
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`;
}

/**
 * Builds the delta text with the formatter that matches the unit. The three
 * modes are separate branches on purpose — a caller cannot accidentally get a
 * relative percentage where a points difference was meant, because the
 * relative formatter is only reached from the explicit `relative-percent`
 * mode.
 */
function buildDelta(
  value: number,
  baseline: ComparableBaseline,
  unit: string | undefined,
  mode: MetricDeltaMode,
  direction: MetricDirection,
): DeltaView {
  const delta = value - baseline.value;
  let text: string;
  let caveat: string | undefined;

  switch (mode) {
    case 'percentage-points':
      text = formatPercentagePoints(delta);
      break;
    case 'relative-percent': {
      if (baseline.value === 0) {
        // A relative change from zero is undefined. Rendering "+100%" (or
        // "Infinity%") here would invent a number, so fall back to the
        // absolute change and say why.
        text = unit ? `${signedNumber(delta)} ${unit}` : signedNumber(delta);
        caveat = 'The baseline was 0, so a relative change is undefined — this is the absolute change.';
      } else {
        text = formatRelativePercent((delta / Math.abs(baseline.value)) * 100);
      }
      break;
    }
    case 'absolute':
    default:
      text = unit ? `${signedNumber(delta)} ${unit}` : signedNumber(delta);
      break;
  }

  const improved =
    direction === 'higher-is-better' ? delta > 0 : direction === 'lower-is-better' ? delta < 0 : null;

  return {
    text,
    tone: delta === 0 || improved === null ? 'neutral' : improved ? 'improved' : 'worsened',
    icon: delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down',
    caveat,
  };
}

function defaultDeltaMode(unit: string | undefined): MetricDeltaMode {
  return unit === '%' || unit === 'pp' ? 'percentage-points' : 'absolute';
}

/**
 * §3.3 Metric tile — value + unit, window/run, source date, coverage, and a
 * delta **only when a comparable baseline exists**.
 *
 * The two rules this component exists to enforce, rather than leave to twelve
 * call sites:
 *
 * 1. A delta needs a `ComparableBaseline`. The type makes a bare number
 *    impossible to pass, and `comparable: true` is re-checked at runtime so a
 *    JavaScript caller cannot bypass it either. With no baseline the tile
 *    renders §3.5's "First measurement — a comparison will appear after a
 *    comparable run" instead of a change.
 * 2. An unmeasured value renders `notMeasuredLabel()` in the `unmeasured`
 *    token. It is never `0`, never blank, and never `danger`: a missing
 *    observation is not a failure (§3.5 "Empty is not zero").
 */
export function MetricTile({
  label,
  value,
  unit,
  windowLabel,
  runLabel,
  runHref,
  sourceDate,
  timeZone,
  coverage,
  baseline,
  deltaMode,
  direction = 'neutral',
  provenance,
  formatValue,
  evidenceHref,
  evidence,
  note,
  notComparableNote,
  isLoading = false,
  className,
}: MetricTileProps) {
  const measured = typeof value === 'number' && Number.isFinite(value);
  // The runtime half of the "delta only when comparable" contract: the type
  // stops a TypeScript caller passing a bare number, and this stops a
  // JavaScript caller passing an object without the literal discriminant.
  const comparableBaseline =
    measured && baseline !== undefined && baseline.comparable === true ? baseline : undefined;
  const baselineHref = runHref ? safeHref(runHref) : undefined;
  const evidenceTarget = evidenceHref ? safeHref(evidenceHref) : undefined;

  if (isLoading) {
    return (
      <Card className={cn('flex flex-col gap-3 p-4', className)} aria-busy="true">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-3 w-40" />
      </Card>
    );
  }

  const deltaView =
    comparableBaseline && typeof value === 'number' && Number.isFinite(value)
      ? buildDelta(value, comparableBaseline, unit, deltaMode ?? defaultDeltaMode(unit), direction)
      : undefined;

  return (
    <Card className={cn('flex flex-col gap-2 p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-meta font-medium text-muted-foreground">{label}</p>
        {/* The unmeasured badge is hard-wired: a caller cannot label a missing
            value as "measured", and it can never be given a danger tone. */}
        {!measured ? (
          <ProvenanceBadge kind="unmeasured" />
        ) : provenance ? (
          <ProvenanceBadge kind={provenance} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {measured ? (
          <span className="text-kpi font-semibold text-foreground">
            {formatValue ? (
              formatValue(value)
            ) : (
              <>
                {formatNumber(value)}
                {unit ? <span className="ml-1 text-table font-normal text-muted-foreground">{unit}</span> : null}
              </>
            )}
          </span>
        ) : (
          // Deliberately smaller than the KPI size: this is a statement about
          // the absence of a measurement, not a headline number.
          <span className="text-subsection font-medium text-unmeasured-foreground">
            {notMeasuredLabel()}
          </span>
        )}

        {deltaView && comparableBaseline ? (
          <DeltaPill delta={deltaView} baseline={comparableBaseline} timeZone={timeZone} />
        ) : null}
      </div>

      {!measured && baseline ? (
        <p className="text-meta text-unmeasured-foreground">
          A comparison is withheld: there is no measured value to compare against a baseline yet.
        </p>
      ) : null}

      {/*
        Three distinct states, and the order matters:
          1. a delta exists            -> render it above
          2. a previous run exists but is not comparable -> `notComparableNote`
          3. nothing to compare        -> the §3.5 "first measurement" line

        State 2 must be checked before state 3, because once a second run exists
        the "first measurement" sentence is simply false. Suppressing the delta
        is the point: G13 requires movement to be withheld rather than implied
        when the methodology changed.
      */}
      {measured && !deltaView && notComparableNote ? (
        <p className="flex items-start gap-1.5 text-meta text-warning-foreground">
          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {notComparableNote}
        </p>
      ) : null}

      {measured && !deltaView && !notComparableNote ? (
        <p className="flex items-start gap-1.5 text-meta text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          First measurement — a comparison will appear after a comparable run
        </p>
      ) : null}

      {deltaView?.caveat ? (
        <p className="text-meta text-warning-foreground">{deltaView.caveat}</p>
      ) : null}

      {note ? <div className="text-meta text-muted-foreground">{note}</div> : null}

      {windowLabel || runLabel || baselineHref ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-muted-foreground">
          <Target aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {windowLabel ? <span>{windowLabel}</span> : null}
          {windowLabel && (runLabel || baselineHref) ? <span aria-hidden="true">·</span> : null}
          {/* A `runHref` on its own still renders a link: "every number links
              to its scoped evidence" (§4) must not depend on the caller also
              remembering a label. */}
          {baselineHref ? (
            <a className="font-medium text-primary hover:underline" href={baselineHref}>
              {runLabel ?? 'Open run'}
            </a>
          ) : runLabel ? (
            <span>{runLabel}</span>
          ) : null}
        </p>
      ) : null}

      {sourceDate ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-muted-foreground">
          <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {sourceDate.sourceName ? <span>{sourceDate.sourceName}</span> : <span>Source captured</span>}
          <span aria-hidden="true">·</span>
          <Timestamp value={sourceDate.date} timeZone={timeZone} dateOnly />
          {/* The date alone is ambiguous across zones, so the zone is always
              named even when only the calendar day is shown (§3.4). */}
          <span>({resolveTimeZone(timeZone)})</span>
        </p>
      ) : null}

      {coverage ? <CoveragePanel variant="compact" summary={coverage} /> : null}

      {evidence ??
        (evidenceTarget ? (
          <a
            className="inline-flex w-fit items-center gap-1 text-meta font-medium text-primary hover:underline"
            href={evidenceTarget}
            {...(isExternalHref(evidenceTarget) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            View evidence
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            {isExternalHref(evidenceTarget) ? <span className="sr-only">(opens in a new tab)</span> : null}
          </a>
        ) : null)}
    </Card>
  );
}

const DELTA_TONE_CLASSES: Record<DeltaView['tone'], string> = {
  improved: 'text-success-foreground',
  // Not `danger`: a metric moving the wrong way is a warning to look at, not a
  // failure of the run. `danger` stays reserved for things that actually broke.
  worsened: 'text-warning-foreground',
  neutral: 'text-muted-foreground',
};

function DeltaPill({
  delta,
  baseline,
  timeZone,
}: {
  delta: DeltaView;
  baseline: ComparableBaseline;
  timeZone?: string;
}) {
  const Icon = delta.icon === 'up' ? ArrowUpRight : delta.icon === 'down' ? ArrowDownRight : Minus;
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-1.5 text-table', DELTA_TONE_CLASSES[delta.tone])}>
      <span className="inline-flex items-center gap-0.5 font-semibold">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        {delta.text}
      </span>
      <span className="text-meta text-muted-foreground">
        {baseline.label ?? 'vs comparable run'}
        {' · '}
        <Timestamp value={baseline.runDate} timeZone={timeZone} dateOnly />
        {' · '}
        <span className="font-mono">{baseline.runId}</span>
      </span>
    </span>
  );
}
