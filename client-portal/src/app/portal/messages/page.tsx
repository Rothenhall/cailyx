'use client';

import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { usePortal } from '../_lib/usePortal';
import { TopBar } from '@/components/ui/TopBar';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { MessageThread } from '@/components/messages/MessageThread';
import { useToast } from '@/components/ui/Toast';

export default function PortalMessagesPage() {
  const user = useRequireAuth('client');
  const { messages, error, sendMessage } = usePortal();
  const { push } = useToast();

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="portal" />
      <main className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        <Link href="/portal" className="text-caption text-faint hover:text-dim">
          ← Projects
        </Link>
        {error && <p className="text-body text-red">{error}</p>}
        <Panel>
          <PanelHeader title="Messages" />
          <MessageThread
            messages={messages}
            selfType="client"
            onSend={async (body) => {
              try {
                await sendMessage(body);
              } catch (err) {
                push(err instanceof Error ? err.message : 'Failed to send message', 'error');
              }
            }}
          />
        </Panel>
      </main>
    </div>
  );
}
