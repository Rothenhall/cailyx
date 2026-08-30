'use client';

/**
 * App shell: header navigation shared by every page. Client component —
 * reads the stored auth token to offer login/logout links.
 *
 * @module components/AppShell
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getToken, setToken } from '@/lib/api';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/login', label: 'Login' },
];

/** Wraps page content with the shared header. */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    setAuthed(getToken() !== null);
  }, [pathname]);

  const logout = () => {
    setToken(null);
    setAuthed(false);
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            Cailyx<span className="ml-2 text-xs font-normal text-slate-500">AI visibility engine</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className={navClass(pathname === '/')}>Dashboard</Link>
            {authed ? (
              <button onClick={logout} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">
                Log out
              </button>
            ) : (
              <Link href="/login" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700">
                Log in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

function navClass(active: boolean): string {
  return active ? 'font-medium text-slate-900' : 'text-slate-600 hover:text-slate-900';
}