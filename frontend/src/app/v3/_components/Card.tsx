/**
 * Card — the one card shell every /v3 surface uses. Solid paper (not the old
 * canvas-glass/backdrop-blur treatment those tiles used when they sat on a
 * dotted canvas background) since /v3 is a normal dashboard now, not a stage.
 *
 * @module app/v3/_components/Card
 */

export function Card({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-r4 border border-border bg-bg-raised shadow-e1 ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  icon,
  action,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
      {icon && <span className="grid h-6 w-6 shrink-0 place-items-center rounded-r2 bg-accent text-bg-raised">{icon}</span>}
      <span className="font-display text-ui font-semibold tracking-tight2 text-text">{title}</span>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  );
}

/** a small headline figure — score, count, whatever the card leads with */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warn' | 'danger';
}) {
  const toneClass = tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-accent';
  return (
    <Card className="p-4">
      <div className="text-eyebrow uppercase tracking-eyebrow text-faint">{label}</div>
      <div className={`num mt-1.5 font-display text-figure font-semibold ${toneClass}`}>{value}</div>
      {hint && <p className="mt-1 text-caption text-faint">{hint}</p>}
    </Card>
  );
}
