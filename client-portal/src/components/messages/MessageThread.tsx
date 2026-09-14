'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

interface ThreadMessage {
  id: string;
  authorType: 'operator' | 'client';
  body: string;
  createdAt: string;
}

/**
 * Shared message thread — used by both /admin/clients/[id] (operator's own
 * messages render right-aligned) and /portal/messages (client's own messages
 * render right-aligned). `selfType` decides which side is "mine".
 */
export function MessageThread({
  messages,
  selfType,
  onSend,
}: {
  messages: ThreadMessage[] | null;
  selfType: 'operator' | 'client';
  onSend: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await onSend(body.trim());
      setBody('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
        {messages === null && <div className="h-16 skeleton" />}
        {messages !== null && messages.length === 0 && (
          <p className="py-4 text-center text-caption text-faint">No messages yet.</p>
        )}
        {messages?.map((m) => {
          const mine = m.authorType === selfType;
          return (
            <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[80%] rounded-r2 px-3 py-2 text-ui',
                  mine ? 'bg-cognac/15 text-text' : 'border border-border bg-bg-inset text-text',
                )}
              >
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="mt-1 text-caption text-faint">
                  {mine ? 'you' : m.authorType} · {new Date(m.createdAt).toLocaleString()}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a message…"
          className="flex-1 rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
        />
        <Button type="submit" variant="primary" disabled={busy || !body.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
