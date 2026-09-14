'use client';

/**
 * /v3/audits — lands on the technical discipline by default.
 * @module app/v3/audits/page
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AuditsIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/v3/audits/technical');
  }, [router]);
  return null;
}
