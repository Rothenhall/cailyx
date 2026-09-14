'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  listPortalProjects,
  listPortalReports,
  listPortalMessages,
  postPortalMessage,
} from '@/lib/endpoints';
import type { PortalProjectDto, PortalReportSummaryDto, PortalMessageDto } from '@/types/api';

/**
 * Client portal data spine — mirrors admin/_lib/useClientDetail.ts's shape
 * (single hook, bootstrap fetch + mutations) but reads the caller's own
 * clientId scope implicitly via the JWT, never an id param.
 */
export function usePortal() {
  const [projects, setProjects] = useState<PortalProjectDto[] | null>(null);
  const [reports, setReports] = useState<PortalReportSummaryDto[] | null>(null);
  const [messages, setMessages] = useState<PortalMessageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, r, m] = await Promise.all([listPortalProjects(), listPortalReports(), listPortalMessages()]);
      setProjects(p.projects);
      setReports(r.reports);
      setMessages(m.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your account');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const running = projects?.some((p) => p.onboardingStatus === 'running') ?? false;
    if (!running) return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [projects, refresh]);

  const sendMessage = useCallback(
    async (body: string, projectId?: string) => {
      await postPortalMessage(body, projectId);
      await refresh();
    },
    [refresh],
  );

  return { projects, reports, messages, error, refresh, sendMessage };
}
