import { api, unwrap } from '@/lib/api';

/**
 * Message-thread adapter (G08 / Appendix C.7).
 *
 * One chronological, client-wide thread per client — design_plan §4.2 OP09.
 * A message may carry a `projectId` tag, but the thread itself is not split by
 * project, because a client relationship is not.
 *
 * Phase note: the current backend thread is append-only with no pagination or
 * read cursors. G08 adds both (`MessageReadCursor`, cursor paging). The
 * functions below are shaped for the target contract and read the current
 * `{ messages: [...] }` envelope, so the UI does not have to change when the
 * real cursors land — but nothing here invents a cursor the server did not
 * return.
 */

export interface ThreadMessage {
  id: string;
  clientId?: string;
  /** Optional project tag on a client-wide thread. */
  projectId: string | null;
  authorUserId?: string;
  /** `operator` or `client`. Never used to claim delivery. */
  authorType: 'operator' | 'client';
  body: string;
  createdAt: string;
}

export async function listClientMessages(
  clientId: string,
  options?: { signal?: AbortSignal },
): Promise<ThreadMessage[]> {
  const payload = await api.get<{ messages: ThreadMessage[] }>(
    `/clients/${clientId}/messages`,
    options,
  );
  return unwrap<ThreadMessage[]>(payload, 'messages');
}

export async function postClientMessage(
  clientId: string,
  input: { body: string; projectId?: string },
) {
  return api.post<ThreadMessage>(`/clients/${clientId}/messages`, input);
}

export async function listPortalMessages(options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ messages: ThreadMessage[] }>('/portal/messages', options);
  return unwrap<ThreadMessage[]>(payload, 'messages');
}

export async function postPortalMessage(input: { body: string; projectId?: string }) {
  return api.post<ThreadMessage>('/portal/messages', input);
}
