import Link from 'next/link';
import { BandBadge, ClientStatusBadge } from '@/components/ui/Badge';
import type { ClientOverviewDto } from '@/types/api';

export function ClientRow({ client }: { client: ClientOverviewDto }) {
  return (
    <Link
      href={`/admin/clients/${client.id}`}
      className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 text-ui transition-colors last:border-b-0 hover:bg-bg-inset"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{client.name}</div>
          {client.contactEmail && <div className="truncate text-caption text-faint">{client.contactEmail}</div>}
        </div>
        {client.hasProjectOnboarding && (
          <span className="pulse-dot rounded-full bg-cognac/15 px-2 py-0.5 text-caption text-cognac">
            onboarding
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 text-caption text-dim">
        <span>{client.projectCount} project{client.projectCount === 1 ? '' : 's'}</span>
        <span>{client.openGapCount} open gap{client.openGapCount === 1 ? '' : 's'}</span>
        <BandBadge band={client.latestBand} />
        <ClientStatusBadge status={client.status} />
      </div>
    </Link>
  );
}
