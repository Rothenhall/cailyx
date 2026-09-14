'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getClient,
  updateClient as updateClientApi,
  createClientProject,
  createClientLogin as createClientLoginApi,
  listClientMessages,
  postClientMessage,
} from '@/lib/endpoints';
import { pollUntilDone } from '@/lib/poll';
import type { ClientDetailDto, ClientMessageDto, ClientLoginCreatedDto } from '@/types/api';

export function useClientDetail(clientId: string) {
  const [client, setClient] = useState<ClientDetailDto | null>(null);
  const [messages, setMessages] = useState<ClientMessageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([getClient(clientId), listClientMessages(clientId)]);
      setClient(c);
      setMessages(m.messages);
      setError(null);
      return c;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load client');
      return null;
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll any project stuck "running" until it settles, then refresh once more.
  // No single-project status endpoint exists — each tick re-fetches the whole
  // client and reads that one project's row back out of it.
  useEffect(() => {
    const running = client?.projects.filter((p) => p.onboardingStatus === 'running') ?? [];
    if (running.length === 0) return;
    let cancelled = false;
    void (async () => {
      await Promise.all(
        running.map((p) =>
          pollUntilDone(
            async () => {
              const c = await getClient(clientId);
              const row = c.projects.find((x) => x.id === p.id);
              return { status: row?.onboardingStatus ?? 'failed' };
            },
            { intervalMs: 4000, timeoutMs: 5 * 60 * 1000 },
          ).catch(() => null),
        ),
      );
      if (!cancelled) void refresh();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client?.projects.map((p) => `${p.id}:${p.onboardingStatus}`).join(','), clientId]);

  const updateClient = useCallback(
    async (patch: Partial<{ name: string; contactName: string; contactEmail: string; status: string; notes: string }>) => {
      await updateClientApi(clientId, patch);
      await refresh();
    },
    [clientId, refresh],
  );

  const addProject = useCallback(
    async (input: { name: string; domain: string }) => {
      await createClientProject(clientId, input);
      await refresh();
    },
    [clientId, refresh],
  );

  const createLogin = useCallback(
    async (input: { email: string; name?: string }): Promise<ClientLoginCreatedDto> => {
      const res = await createClientLoginApi(clientId, input);
      return res;
    },
    [clientId],
  );

  const sendMessage = useCallback(
    async (body: string, projectId?: string) => {
      await postClientMessage(clientId, body, projectId);
      const m = await listClientMessages(clientId);
      setMessages(m.messages);
    },
    [clientId],
  );

  return { client, messages, error, refresh, updateClient, addProject, createLogin, sendMessage };
}
