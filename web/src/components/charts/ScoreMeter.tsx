import { cn } from '@/lib/utils';
import { bandMeta, clampScore } from './score';

export interface ScoreMeterProps {
  score: number;
  band: string | null;
  /** `lg` is the headline treatment: full width, with the value at KPI size. */
  size?: 'sm' | 'lg';
  className?: string;
}

/**
 * A score as a bounded magnitude against its 0–100 scale, rather than a bare
 * number with nothing to read it against.
 *
 * Thin track, rounded data-end, value direct-labelled. The band's colour never
 * carries the meaning alone — callers show the band name as text alongside, and
 * the accessible name states both (§3.4).
 */
export function ScoreMeter({ score, band, size = 'sm', className }: ScoreMeterProps) {
  const meta = bandMeta(band);
  const pct = clampScore(score);

  return (
    <div className={cn('flex items-center', size === 'lg' ? 'gap-4' : 'gap-3', className)}>
      <div
        role="img"
        aria-label={`Score ${score} out of 100${meta ? `, ${meta.label}` : ''}`}
        className={cn(
          'overflow-hidden rounded-full bg-surface-sunken',
          size === 'lg' ? 'h-2 w-full' : 'h-1.5 w-24',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-slow ease-out',
            meta?.fill ?? 'bg-unmeasured',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          'shrink-0 font-semibold tabular-nums',
          size === 'lg' ? 'text-kpi leading-none' : 'text-table',
        )}
      >
        {score}
      </span>
    </div>
  );
}
