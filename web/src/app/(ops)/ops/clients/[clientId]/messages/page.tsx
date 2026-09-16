'use client';

import { useCallback } from 'react';
import { useParams } from 'next/navigation';
import { MessageThread } from '@/components/patterns/MessageThread';
import { PageHeader } from '@/components/patterns/PageHeader';
import { listClientMessages, postClientMessage } from '@/services/messages';

/**
 * OP09 — Client conversation.
 *
 * design_plan.md §4.2: "One chronological client-wide thread, project tag,
 * composer, visible to the client." The client-wide scope is deliberate and
 * matches the data model — a client relationship is not split by project, even
 * though a message may carry a project tag.
 *
 * Everything visible here is also visible to the client. §4.2's internal-note
 * rule means operator-only commentary does not belong on this page at all;
 * G08 models it as a separate server-side channel rather than a toggle here.
 */
export default function ClientMessagesPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params.clientId;

  const load = useCallback(
    (options?: { signal?: AbortSignal }) => listClientMessages(clientId, options),
    [clientId],
  );

  const post = useCallback(
    (input: { body: string }) => postClientMessage(clientId, input),
    [clientId],
  );

  return (
    <div className="flex h-[calc(100vh-var(--topbar)-3rem)] flex-col space-y-4">
      <PageHeader
        breadcrumbs={[
          { label: 'Clients', href: '/ops/clients' },
          { label: 'Client', href: `/ops/clients/${clientId}` },
        ]}
        title="Messages"
        context="This thread is visible to the client. Do not put internal notes here."
      />
      <div className="min-h-0 flex-1">
        <MessageThread viewer="operator" load={load} post={post} />
      </div>
    </div>
  );
}
