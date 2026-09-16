import { OpsShell } from '@/components/layouts/OpsShell';

/**
 * The within-project operator surface. Same shell, different navigation: the
 * shell detects the `/projects/:id` prefix and swaps in the project tree, so
 * the top bar (and therefore the project context) never disappears.
 */
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <OpsShell>{children}</OpsShell>;
}
