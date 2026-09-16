import { OpsShell } from '@/components/layouts/OpsShell';

/**
 * Layout for the operator workspace.
 *
 * A route group `(ops)` keeps operator URLs at the root (`/ops`, `/projects/…`)
 * while still applying this shell. design_plan.md §10.1 notes that route groups
 * are an organizational device and not an authorization boundary — the operator
 * guard is on the backend, and `OpsShell` is presentation only.
 */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <OpsShell>{children}</OpsShell>;
}
