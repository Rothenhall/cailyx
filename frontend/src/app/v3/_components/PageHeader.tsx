/**
 * PageHeader — every /v3 route owns its own title/description/actions
 * instead of the shell guessing a title from the URL. Keeps Topbar dumb and
 * every page self-describing.
 *
 * @module app/v3/_components/PageHeader
 */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-text">{title}</h1>
        {description && <p className="mt-1 text-body text-faint">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
