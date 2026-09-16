import { ClientShell } from '@/components/layouts/ClientShell';

/**
 * Client portal layout.
 *
 * A route group `(client)` keeps these URLs under `/client` while applying the
 * client shell. Per design_plan.md §10.1 this grouping is organizational only:
 * authorization comes from the backend's `@ClientPortal()` guard, which is
 * default-deny for operator routes and for client users alike.
 */
export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return <ClientShell>{children}</ClientShell>;
}
