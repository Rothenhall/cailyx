import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus, Rocket } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  formatNumber,
  formatPercentagePoints,
  formatRelativePercent,
  resolveTimeZone,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ChangeComparisonData, ChangeComparisonSide } from '@/types';

/**
 * The arithmetic behind the headline change. The three options are never
 * interchangeable (§3.4): a score moving 42% → 47% is "+5 pp", the same move
 * as a relative change is "+11.9%", and a count moving 900 → 1,200 is "+300
 * clicks". Picking one necessarily excludes the others.
 */
export type ChangeMode = 'absolute' | 'percentage-points' | 'relative-percent';

/** Which way is good. `neutral` (the default) states the direction of change
 *  without dressing it as an improvement or a decline. */
export type ChangeDirection = 'higher-is-better' | 'lower-is-better' | 'neutral';

export interface ChangeComparisonProps {
  /** The two runs/versions being compared, their unit and comparability. */
  data: ChangeComparisonData;
  /** Overrides the arithmetic used for the change. Defaults to
   *  `percentage-points` for `%`/`pp` units and `absolute` otherwise;
   *  `relative-percent` is never inferred. */
  changeMode?: ChangeMode;
  /** Whether a rise in this metric is good. Defaults to `neutral`. */
  direction?: ChangeDirection;
  /** Formats a side's value. Defaults to `formatNumber` plus the unit. */
  formatValue?: (value: number, unit: string) => string;
  /** What differed between the runs — shown with the "not comparable" warning
   *  so the reader is told which part of the comparison key changed (§6.4). */
  methodologyNote?: React.ReactNode;
  /** IANA zone for the two dates. */
  timeZone?: string;
  className?: string;
}

interface ChangeView {
  text: string;
  tone: 'improved' | 'worsened' | 'neutral';
  icon: 'up' | 'down' | 'flat';
  caveat?: string;
}

function signedNumber(value: number): string {
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`;
}

function defaultMode(unit: string): ChangeMode {
  return unit === '%' || unit === 'pp' ? 'percentage-points' : 'absolute';
}

function buildChange(
  before: number,
  after: number,
  unit: string,
  mode: ChangeMode,
  direction: ChangeDirection,
): ChangeView {
  const delta = after - before;
  let text: string;
  let caveat: string | undefined;

  switch (mode) {
    case 'percentage-points':
      text = formatPercentagePoints(delta);
      break;
    case 'relative-percent':
      if (before === 0) {
        // A relative change from zero is undefined — say so instead of
        // printing "Infinity%" or a made-up "+100%".
        text = `${signedNumber(delta)}${unit ? ` ${unit}` : ''}`;
        caveat = 'The before value was 0, so a relative change is undefined; this is the absolute change.';
      } else {
        text = formatRelativePercent((delta / Math.abs(before)) * 100);
      }
      break;
    case 'absolute':
    default:
      text = `${signedNumber(delta)}${unit ? ` ${unit}` : ''}`;
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

const TONE_CLASSES: Record<ChangeView['tone'], string> = {
  improved: 'text-success-foreground',
  // A metric that moved the wrong way is a warning, not a failure of the run.
  worsened: 'text-warning-foreground',
  neutral: 'text-foreground',
};

/**
 * §3.3 Change comparison — before/after IDs and dates, the absolute change, its
 * unit, methodology compatibility and the deployments that fall in the window.
 *
 * Contract (design_plan G13 / §6.4): when `methodologyCompatible` is false the
 * component says so prominently and **withholds the implied clean delta**. The
 * comparison key includes query-set version, engine/model/transport, market,
 * repeats and rubric version; if any of those changed, the difference between
 * the two numbers is not a measurement of improvement, so no change figure and
 * no direction arrow are rendered — only the two values side by side and the
 * reason. The check is `=== true`, not truthiness, so a caller that forgot to
 * declare compatibility gets the conservative answer.
 */
export function ChangeComparison({
  data,
  changeMode,
  direction = 'neutral',
  formatValue,
  methodologyNote,
  timeZone,
  className,
}: ChangeComparisonProps) {
  const { before, after, unit, relevantDeployments } = data;
  const compatible = data.methodologyCompatible === true;
  const mode = changeMode ?? defaultMode(unit);
  const change = buildChange(before.value, after.value, unit, mode, direction);
  const formatSide = (side: ChangeComparisonSide): string =>
    formatValue ? formatValue(side.value, unit) : `${formatNumber(side.value)}${unit ? ` ${unit}` : ''}`;

  return (
    <Card className={cn('p-4', className)} data-methodology={compatible ? 'compatible' : 'break'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-body font-semibold text-foreground">Change comparison</h3>
        {!compatible ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning-subtle px-2 py-0.5 text-meta font-semibold text-warning-foreground">
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Methodology break
          </span>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ComparisonSide side={before} label="Before" formatSide={formatSide} timeZone={timeZone} />
        <ComparisonSide side={after} label="After" formatSide={formatSide} timeZone={timeZone} />
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {compatible ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-meta text-muted-foreground">Change</span>
            <span
              className={cn('inline-flex items-center gap-1 text-subsection font-semibold', TONE_CLASSES[change.tone])}
            >
              <ChangeIcon icon={change.icon} />
              {change.text}
            </span>
            {mode === 'percentage-points' ? (
              <span className="text-meta text-muted-foreground">
                (percentage points — not a relative percentage change)
              </span>
            ) : null}
            {mode === 'relative-percent' ? (
              <span className="text-meta text-muted-foreground">
                (relative change against the before value)
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-meta text-muted-foreground">Change</span>
            <span className="text-subsection font-semibold text-warning-foreground">
              Not comparable — withheld
            </span>
          </div>
        )}

        {change.caveat && compatible ? (
          <p className="mt-1 text-meta text-warning-foreground">{change.caveat}</p>
        ) : null}
      </div>

      {!compatible ? (
        <div
          role="note"
          className="mt-3 flex gap-2 rounded-md border border-warning/40 bg-warning-subtle p-3 text-table text-warning-foreground"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">
              These two runs used different methodology, so the difference between them is not a measured
              change.
            </p>
            <p className="mt-1">
              {formatSide(before)} and {formatSide(after)} are shown as recorded, with the date each was
              captured. No improvement or decline is calculated from them, because the comparison key
              (query set, engine/model/transport, market, repeats or rubric version) changed between the
              two.
            </p>
            {methodologyNote ? <div className="mt-2">{methodologyNote}</div> : null}
          </div>
        </div>
      ) : null}

      {relevantDeployments && relevantDeployments.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <h4 className="flex items-center gap-1.5 text-meta font-semibold text-foreground">
            <Rocket aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            Deployments and changes between these runs
          </h4>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-table text-muted-foreground">
            {relevantDeployments.map((deployment) => (
              <li key={deployment}>{deployment}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-meta text-muted-foreground">
            Listed for context only. A change landing in the same window is not evidence that one of these
            caused the movement.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function ChangeIcon({ icon }: { icon: ChangeView['icon'] }) {
  const Icon = icon === 'up' ? ArrowUpRight : icon === 'down' ? ArrowDownRight : Minus;
  return <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />;
}

function ComparisonSide({
  side,
  label,
  formatSide,
  timeZone,
}: {
  side: ChangeComparisonSide;
  label: string;
  formatSide: (side: ChangeComparisonSide) => string;
  timeZone?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <p className="text-meta font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-subsection font-semibold text-foreground">{formatSide(side)}</p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
        <span className="font-mono break-all">{side.id}</span>
        <span aria-hidden="true">·</span>
        <Timestamp value={side.date} timeZone={timeZone} dateOnly />
        {/* The calendar day depends on the zone, so the zone is always named. */}
        <span>({resolveTimeZone(timeZone)})</span>
      </p>
    </div>
  );
}
