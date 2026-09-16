import Link from 'next/link';

/**
 * The shell for shared, unauthenticated surfaces — design_plan.md §4.1:
 * a shared report (PB01), a shared scorecard (PB02), the public diagnostic
 * request (PB03), a checkout return (PB04), and the error pages (PB05).
 *
 * Deliberately minimal. These pages are opened by people who are not signed in
 * and may not be clients, so there is no navigation tree, no account menu, and
 * no route into any other project. The only chrome is the wordmark and a
 * sign-in link.
 *
 * §10.5 applies here more than anywhere: a shared page renders a *snapshot*
 * that was released deliberately. Nothing on these pages reads live data, and
 * the content they show was frozen at release time.
 */
export interface PublicShellProps {
  /** Shown top-right, e.g. "September report" or "Diagnostic request". */
  contextLabel?: string;
  children: React.ReactNode;
}

export function PublicShell({ contextLabel, children }: PublicShellProps) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-topbar max-w-content items-center justify-between px-4 sm:px-6">
          <Link href="/" className="text-subsection font-semibold tracking-tight">
            Cailyx
          </Link>
          {contextLabel ? (
            <span className="truncate text-table text-muted-foreground">{contextLabel}</span>
          ) : null}
          <Link
            href="/sign-in"
            className="text-table text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-reading px-4 py-8 sm:px-6">
        {children}
      </main>
      <footer className="border-t border-border py-6">
        <div className="mx-auto max-w-content px-4 text-meta text-muted-foreground sm:px-6">
          This page shows a snapshot taken when it was published. Figures it
          contains are not updated after that date.
        </div>
      </footer>
    </div>
  );
}
