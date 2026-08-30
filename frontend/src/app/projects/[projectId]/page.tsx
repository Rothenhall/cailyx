'use client';

/**
 * Legacy per-project route — the terminal is now a single console at `/` with a
 * project switcher. Redirect there, remembering which project was requested.
 *
 * @module app/projects/[projectId]/page
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function LegacyProjectRedirect() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();

  useEffect(() => {
    if (params?.projectId) {
      try {
        window.localStorage.setItem('cailyx.lastProject', params.projectId);
      } catch {
        /* ignore */
      }
    }
    router.replace('/');
  }, [params, router]);

  return <div className="grid min-h-screen place-items-center text-faint">opening terminal…</div>;
}
