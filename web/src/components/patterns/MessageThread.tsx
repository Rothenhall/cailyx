'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from './EmptyState';
import { ErrorState, clientActionMessage, toApiError } from './ErrorState';
import { Timestamp } from './Timestamp';

/**
 * The client conversation thread — design_plan.md OP09 (operator) and CP13
 * (client). One component, because §4.2 and §4.5 describe the same object
 * viewed from two sides, and two implementations would drift.
 *
 * The rule that matters most here is §10.4's failed-send row: *"Keep content,
 * distinguish saved message/login/report from failed email delivery."* So a
 * send failure never clears the composer. The draft stays in the box, the
 * error appears next to it, and the message is only removed from the box once
 * the server has actually accepted it.
 *
 * `viewer` decides which side your messages sit on. It is presentation, not
 * authorization — the server decides who may post to a thread, and it derives
 * the author from the token, never from anything sent here.
 */

export interface MessageThreadProps {
  /** Who is looking at this thread, which sets the alignment. */
  viewer: 'operator' | 'client';
  /** Loads the thread. Callers pass the scoped adapter for their surface. */
  load: (options?: { signal?: AbortSignal }) => Promise<import('@/services/messages').ThreadMessage[]>;
  /** Posts a message. */
  post: (input: { body: string }) => Promise<unknown>;
  /** Optional callbacks for project tagging — OP09 allows a project tag. */
  projectTags?: { id: string; name: string }[];
  /** Shown when the server reported that an email notification failed. */
  onSent?: (info: { emailAttempted?: boolean; emailSent?: boolean }) => void;
}

export function MessageThread({ viewer, load, post, onSent }: MessageThreadProps) {
  const [messages, setMessages] = useState<import('@/services/messages').ThreadMessage[] | null>(
    null,
  );
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        setMessages(await load({ signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      }
    },
    [load],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // New messages scroll into view; the composer keeps focus so a reply is one
  // keystroke away.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length]);

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setSendError(null);

    try {
      await post({ body });
      // Only now is the text cleared — the server has it.
      setDraft('');
      await refresh();
      onSent?.({ emailAttempted: true });
      textareaRef.current?.focus();
    } catch (caught) {
      // §10.4: keep the content. The draft is deliberately NOT cleared here.
      // §4.3: a client reader gets what kind of failure this was, in words —
      // never the server's own message, which can name internal records.
      // §10.4: the draft is kept either way, and the sentence says so.
      setSendError(
        clientActionMessage(caught, 'Not sent. Your message is still in the box below.'),
      );
    } finally {
      setSending(false);
    }
  }

  if (loadError) {
    // `viewer` is already the client/operator switch, so it is the same
    // boundary that decides whether the server's own message may be shown: a
    // client reader sees the kind of failure, staff keep the diagnostic text.
    return (
      <ErrorState
        error={loadError}
        onRetry={() => void refresh()}
        layout="inline"
        showServerMessage={viewer === 'operator'}
      />
    );
  }

  if (!messages) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="ml-auto h-16 w-2/3" />
        <Skeleton className="h-16 w-3/4" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <EmptyState variant="no-messages" viewer={viewer} />
        ) : (
          messages.map((message) => (
            <MessageBubble key={message.id} message={message} viewer={viewer} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="mt-4 shrink-0 space-y-2 border-t border-border pt-4">
        {sendError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{sendError}</AlertDescription>
          </Alert>
        ) : null}

        <label htmlFor="message-body" className="sr-only">
          Write a message
        </label>
        <Textarea
          id="message-body"
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          placeholder="Write a message…"
          disabled={sending}
          aria-describedby={sendError ? 'message-error' : undefined}
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter sends; plain Enter makes a new line, because
            // these messages are prose and accidental sends are costly.
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void send(event as unknown as React.FormEvent<HTMLFormElement>);
            }
          }}
        />

        <div className="flex items-center justify-between gap-2">
          <p className="text-meta text-muted-foreground">
            Press ⌘/Ctrl + Enter to send.
          </p>
          <Button type="submit" size="sm" disabled={sending || !draft.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  viewer,
}: {
  message: import('@/services/messages').ThreadMessage;
  viewer: 'operator' | 'client';
}) {
  const mine = message.authorType === viewer;

  return (
    <div className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <span className="font-medium">
          {message.authorType === 'operator' ? 'Delivery team' : 'Client'}
        </span>
        {/* §3.4 — the timezone is part of the timestamp, not a footnote. */}
        <Timestamp value={message.createdAt} />
      </div>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-table',
          mine
            ? 'bg-primary-subtle text-foreground'
            : 'border border-border bg-surface text-foreground',
        )}
      >
        {/* Rendered as text. §10.5 — never as trusted application markup. */}
        {message.body}
      </div>
    </div>
  );
}
