/**
 * The client's view of one of their own projects.
 *
 * This route group deliberately adds **no shell of its own**. Next.js nests
 * layouts by path segment, so `/client/projects/**` already renders under
 * `(client)/client/layout.tsx` — wrapping `ClientShell` around the children
 * again here would draw a second navigation shell inside the first.
 *
 * `ClientShell` already detects the `/client/projects/:projectId` prefix and
 * swaps `CLIENT_NAV` for `CLIENT_PROJECT_NAV`, so the project tree is exactly
 * what the parent layout renders; nothing is lost by this file being a
 * pass-through.
 */
export default function ClientProjectLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
