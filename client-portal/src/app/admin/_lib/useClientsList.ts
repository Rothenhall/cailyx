'use client';

import { useCallback, useEffect, useState } from 'react';
import { listClients, createClient as createClientApi } from '@/lib/endpoints';
import type { ClientOverviewDto } from '@/types/api';

export function useClientsList() {
  const [clients, setClients] = useState<ClientOverviewDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listClients();
      setClients(res.clients);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clients');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createClient = useCallback(
    async (input: { name: string; contactName?: string; contactEmail?: string; notes?: string }) => {
      await createClientApi(input);
      await refresh();
    },
    [refresh],
  );

  return { clients, error, refresh, createClient };
}
