'use client';

import { useCallback } from 'react';
import { MessageThread } from '@/components/patterns/MessageThread';
import { PageHeader } from '@/components/patterns/PageHeader';
import { listPortalMessages, postPortalMessage } from '@/services/messages';

/**
 * CP13 — Messages.
 *
 * design_plan.md §4.5: "One client thread, project tags, chronological
 * messages, composer." The same thread the operator sees on OP09, rendered
 * from the client's side.
 *
 * This page takes no client id from the URL or from state. The backend scopes
 * the thread from the session, so there is no id here to tamper with.
 */
export default function ClientMessagesPage() {
  const load = useCallback(
    (options?: { signal?: AbortSignal }) => listPortalMessages(options),
    [],
  );

  const post = useCallback((input: { body: string }) => postPortalMessage(input), []);

  return (
    <div className="flex h-[calc(100vh-var(--topbar)-3rem)] flex-col space-y-4">
      <PageHeader
        title="Messages"
        context="Your delivery team reads and answers everything here."
      />
      <div className="min-h-0 flex-1">
        <MessageThread viewer="client" load={load} post={post} />
      </div>
    </div>
  );
}
