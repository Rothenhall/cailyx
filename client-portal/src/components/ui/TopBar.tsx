'use client';

import { useRouter } from 'next/navigation';
import { setSession } from '@/lib/api';
import type { AuthUser } from '@/types/api';
import { Button } from './Button';

export function TopBar({ user, label }: { user: AuthUser | null; label: string }) {
  const router = useRouter();

  const logout = () => {
    setSession(null);
    router.replace('/login');
  };

  return (
    <header className="flex items-center justify-between border-b border-border bg-bg-raised px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-cognac">▚</span>
        <span className="text-ui font-semibold tracking-wide">CAILYX</span>
        <span className="text-caption text-faint">· {label}</span>
      </div>
      <div className="flex items-center gap-3">
        {user && <span className="text-caption text-faint">{user.name || user.email}</span>}
        <Button onClick={logout}>log out</Button>
      </div>
    </header>
  );
}
