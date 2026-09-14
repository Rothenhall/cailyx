import { cn } from '@/lib/utils';

const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium';

/** Score band — invisible/faint/present/recommended. Uses the report-view traffic-light ramp. */
export function BandBadge({ band }: { band: string | null }) {
  if (!band) return <span className={cn(base, 'border border-border text-faint')}>not scored</span>;
  const styles: Record<string, string> = {
    invisible: 'bg-[var(--a-bad-soft)] text-[var(--a-bad)] border border-[var(--a-bad-line)]',
    faint: 'bg-[var(--a-warn-soft)] text-[var(--a-warn)] border border-[var(--a-warn-line)]',
    present: 'bg-[var(--a-ok-soft)] text-[var(--a-ok)] border border-[var(--a-ok-line)]',
    recommended: 'bg-[var(--a-ok-soft)] text-[var(--a-ok)] border border-[var(--a-ok-line)]',
  };
  return <span className={cn(base, styles[band] ?? 'border border-border text-dim')}>{band}</span>;
}

/** Client status — active/paused/churned. Brand ramp (no traffic-light needed here). */
export function ClientStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-accent-dim/20 text-accent border border-accent-dim/40',
    paused: 'bg-cognac-soft/20 text-cognac border border-cognac-soft/40',
    churned: 'bg-red/10 text-red border border-red/30',
  };
  return <span className={cn(base, styles[status] ?? 'border border-border text-dim')}>{status}</span>;
}

/** Onboarding status — pending/running/completed/failed. */
export function OnboardingBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'border border-border text-faint',
    running: 'bg-cognac/15 text-cognac border border-cognac/30 pulse-dot',
    completed: 'bg-accent-dim/20 text-accent border border-accent-dim/40',
    failed: 'bg-red/10 text-red border border-red/30',
  };
  return <span className={cn(base, styles[status] ?? 'border border-border text-dim')}>{status}</span>;
}

/** Severity — low/medium/high. Traffic-light ramp, same discipline as BandBadge. */
export function SeverityBadge({ severity }: { severity: string | null }) {
  if (!severity) return null;
  const styles: Record<string, string> = {
    low: 'bg-[var(--a-ok-soft)] text-[var(--a-ok)] border border-[var(--a-ok-line)]',
    medium: 'bg-[var(--a-warn-soft)] text-[var(--a-warn)] border border-[var(--a-warn-line)]',
    high: 'bg-[var(--a-bad-soft)] text-[var(--a-bad)] border border-[var(--a-bad-line)]',
  };
  return <span className={cn(base, styles[severity] ?? 'border border-border text-dim')}>{severity}</span>;
}
