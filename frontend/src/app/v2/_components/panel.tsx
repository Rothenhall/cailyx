/**
 * panel — the shared building blocks every agent detail panel is made of.
 *
 * These existed as copy-paste before: the section label appeared twelve times
 * across four files, the leading figure was duplicated with a hardcoded
 * `text-[30px]` that sat outside the type scale, and each panel wrote its own
 * skeleton. One definition each keeps the panels reading as one product.
 *
 * @module app/v2/_components/panel
 */

/** the small uppercase label above a block */
export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="text-eyebrow uppercase text-faint">{children}</span>
      {right}
    </div>
  );
}

/**
 * The one number a panel leads with, with its sentence beside it and a quiet
 * supporting line underneath.
 */
export function StatHeadline({
  value,
  label,
  note,
  tone = 'accent',
}: {
  value: string;
  label: string;
  note?: string;
  tone?: 'accent' | 'warn';
}) {
  return (
    <div className="rounded-r3 border border-border bg-bg-raised px-3.5 py-3">
      <div className="flex items-baseline gap-2">
        <span
          className={`num font-display text-figure font-semibold ${
            tone === 'warn' ? 'text-warn' : 'text-accent'
          }`}
        >
          {value}
        </span>
        <span className="min-w-0 text-body text-dim">{label}</span>
      </div>
      {note && <p className="mt-1.5 text-caption text-faint">{note}</p>}
    </div>
  );
}

/** the loading state for a panel — same rhythm everywhere */
export function PanelSkeleton({ rows = 3, height = 'h-14' }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`v2skel ${height} rounded-r3`} />
      ))}
    </div>
  );
}

/** an explanation where data would be — never a bare blank */
export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-r3 border border-border bg-bg-raised p-3.5">
      <p className="text-body leading-relaxed text-dim">{children}</p>
    </div>
  );
}
