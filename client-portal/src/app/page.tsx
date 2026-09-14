'use client';

/**
 * Root — redirects to the right surface based on stored session, or /login
 * if there isn't one. Nothing renders here.
 *
 * @module app/page
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, getUser } from '@/lib/api';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const token = getToken();
    const user = getUser();
    if (!token || !user) {
      router.replace('/login');
    } else {
      router.replace(user.type === 'client' ? '/portal' : '/admin');
    }
  }, [router]);

  return null;
}
