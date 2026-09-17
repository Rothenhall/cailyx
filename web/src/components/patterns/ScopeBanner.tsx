import { Activity, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScopeContext } from '@/types';

export interface ScopeBannerProps {
  /** Client, domain, market, project, run/version and live-vs-snapshot mode. */
  scope: ScopeContext;
  /** Right-hand controls, e.g. an "Exit snapshot" link or a report/run switch.
   *  A slot rather than a callback pair so this banner stays renderable from
   *  server components. */
  actions?: React.ReactNode;
  /** Pin the banner to the top of a scrolling run/evidence detail view (§4
   *  "sticky scope/run header"). */
  sticky?: boolean;
  className?: string;
}

/**
 * §3.3 Scope banner — the client, domain, market, project and run/version the
 * screen behind it is scoped to, plus whether the reader is looking at live
 * data or a frozen released snapshot.
 *
 * Contract: in `snapshot` mode the banner is unmistakable — a warning-toned
 * strip, a "Frozen snapshot" label and a sentence saying in words that the
 * figures below are the released version and not current data. §3.5 and §6.4
 * both hinge on that: old reports are immutable, so a reader who mistakes a
 * snapshot for live data will draw the wrong conclusion from every number on
 * the page. Live mode stays deliberately quiet so the loud treatment keeps
 * meaning something.
 *
 * Deliberately **not** marked `no-print`: §3.4 requires printed reports to
 * carry explicit snapshot/date context, so this must survive to paper.
 */
export function ScopeBanner({ scope, actions, sticky = false, className }: ScopeBannerProps) {
  const isSnapshot = scope.mode === 'snapshot';

  const fields: Array<{ label: string; value: string | undefined }> = [
    { label: 'Client', value: scope.clientName },
    { label: 'Domain', value: scope.domain },
    // §4.3: "Geo / markets → Target locations."
    { label: 'Target location', value: scope.market },
    { label: 'Project', value: scope.projectName },
    // §4.3: "Re-run pipeline → Update results"; a "run" is internal shorthand.
    // What the reader needs is which period these figures belong to.
    { label: isSnapshot ? 'Version' : 'Period', value: scope.runLabel },
  ];
  const visibleFields = fields.filter((field): field is { label: string; value: string } => Boolean(field.value));

  return (
    <section
      aria-label="Scope"
      data-mode={scope.mode}
      className={cn(
        'rounded-lg border',
        isSnapshot
          ? 'border-warning/40 border-l-4 border-l-warning bg-warning-subtle'
          : 'border-border bg-surface',
        sticky && 'sticky top-0 z-20',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        {isSnapshot ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-warning/40 bg-surface px-2 py-1 text-meta font-semibold text-warning-foreground">
            <History aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Frozen snapshot
            <span className="sr-only">
              — you are viewing a released, frozen version of the data, not live data.
            </span>
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-info/40 bg-info-subtle px-2 py-1 text-meta font-medium text-info-foreground">
            <Activity aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Live data
            <span className="sr-only">— current data, read from the source on request.</span>
          </span>
        )}

        {visibleFields.length > 0 ? (
          <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            {visibleFields.map((field) => (
              <div key={field.label} className="flex min-w-0 items-baseline gap-1.5">
                <dt className="text-meta text-muted-foreground">{field.label}</dt>
                <dd className="truncate text-table font-medium text-foreground">{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      {isSnapshot ? (
        <p className="border-t border-warning/30 px-3 py-2 text-meta text-warning-foreground">
          {scope.snapshotLabel ? <span className="font-semibold">{scope.snapshotLabel}. </span> : null}
          This is the released version as it was published, held read-only. Data collected after the
          release is not included, and later measurements do not change these figures. Switch to live
          scope to see current data.
        </p>
      ) : null}
    </section>
  );
}
