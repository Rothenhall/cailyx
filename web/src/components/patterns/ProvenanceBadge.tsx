import { CircleDashed, FlaskConical, Lightbulb, Sparkles, UserCheck, Waypoints } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProvenanceKind } from '@/types';

/**
 * §3.3 Provenance badge — distinguishes measured / model-interpretation /
 * operator-supplied / discovered-candidate / derived / unmeasured.
 *
 * Contract: `unmeasured` always uses the `unmeasured` token, never `danger`.
 * An unmeasured value is a missing observation, not a failure, so it is
 * hard-wired below rather than left to each call site to get right.
 */
const CONFIG: Record<
  ProvenanceKind,
  { label: string; icon: typeof FlaskConical; classes: string }
> = {
  measured: {
    label: 'Measured',
    icon: FlaskConical,
    classes: 'bg-success-subtle text-success-foreground border-success/30',
  },
  'model-interpretation': {
    label: 'Model interpretation',
    icon: Sparkles,
    classes: 'bg-info-subtle text-info-foreground border-info/30',
  },
  'operator-supplied': {
    label: 'Operator supplied',
    icon: UserCheck,
    classes: 'bg-primary-subtle text-primary border-primary/30',
  },
  'discovered-candidate': {
    label: 'Discovered candidate',
    icon: Waypoints,
    classes: 'bg-warning-subtle text-warning-foreground border-warning/30',
  },
  derived: {
    label: 'Derived',
    icon: Lightbulb,
    classes: 'bg-surface-sunken text-foreground border-border-strong',
  },
  // Deliberately the `unmeasured` token, never `danger` — see contract above.
  unmeasured: {
    label: 'Not measured',
    icon: CircleDashed,
    classes: 'bg-unmeasured-subtle text-unmeasured-foreground border-unmeasured/30',
  },
};

export interface ProvenanceBadgeProps {
  kind: ProvenanceKind;
  /** Overrides the default label, e.g. "Measured 3 Sep" for extra context. */
  label?: string;
  className?: string;
}

export function ProvenanceBadge({ kind, label, className }: ProvenanceBadgeProps) {
  const { label: defaultLabel, icon: Icon, classes } = CONFIG[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-meta font-medium',
        classes,
        className,
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {label ?? defaultLabel}
    </span>
  );
}
