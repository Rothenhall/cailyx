'use client';

/**
 * Admin console shell — client management, onboarding, findings/fixes,
 * scheduling. Fully separate from the existing `/`, `/v2`, `/v3` workspace UI
 * (built with shadcn/ui); shares only the auth session + API client.
 *
 * @module app/admin/layout
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getToken, setSession, ApiError } from '@/lib/api';
import { getMe } from '@/lib/admin-api';
import type { User } from '@/types/api';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (getToken() === null) {
      router.replace('/login');
      return;
    }
    getMe()
      .then((me) => {
        setUser(me);
        setReady(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          setSession(null);
          router.replace('/login');
          return;
        }
        setReady(true);
      });
  }, [router]);

  const logout = () => {
    setSession(null);
    router.replace('/login');
  };

  const initials = (user?.name || user?.email || '?').slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/admin" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="text-primary">▚</span>
            <span>Cailyx</span>
            <span className="text-muted-foreground font-normal">Admin</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/admin"
              className={
                pathname === '/admin'
                  ? 'rounded-md bg-accent px-3 py-1.5 font-medium text-accent-foreground'
                  : 'rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }
            >
              Clients
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline">{user.name}</span>
                <span className="hidden rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide sm:inline">
                  {user.role}
                </span>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={logout}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{ready ? children : <ShellSkeleton />}</main>
      <Toaster position="top-right" />
    </div>
  );
}

function ShellSkeleton() {
  return <div className="h-40 animate-pulse rounded-lg bg-muted" />;
}
