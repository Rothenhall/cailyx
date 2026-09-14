'use client';

/**
 * /v3 — the consolidated operator console. Real routes per workspace
 * (replacing /v2's single-route, client-state section-switching), sharing
 * one session + chrome via SessionProvider/V3Shell. Requires a session —
 * unauthenticated hits bounce to /login (enforced inside useSession).
 *
 * @module app/v3/layout
 */

import './v3.css';
import { SessionProvider } from './_lib/SessionContext';
import { V3Shell } from './_components/V3Shell';

export default function V3Layout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <V3Shell>{children}</V3Shell>
    </SessionProvider>
  );
}
