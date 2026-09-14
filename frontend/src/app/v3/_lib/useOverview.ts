'use client';

/**
 * useOverview — Overview-route-only data: the Flywheel's suggestion wheel and
 * the active project's query sets (needed to know whether a measurement run
 * can be offered). Split out of /v2's useConsole so these fetch only when the
 * Overview route is actually mounted, not on every route.
 *
 * @module app/v3/_lib/useOverview
 */

import { useEffect, useRef, useState } from 'react';
import { cacheGet, cacheSet } from '@/lib/api';
import { getSuggestions, listQuerySets, type QuerySet } from '@/lib/terminal-api';
import type { SuggestionWheel } from '@/components/terminal/Flywheel';

export function useOverview(activeId: string | null) {
  const [wheel, setWheel] = useState<SuggestionWheel | null>(null);
  const [wheelLoading, setWheelLoading] = useState(false);
  const [querySets, setQuerySets] = useState<QuerySet[] | null>(null);

  const liveId = useRef<string | null>(null);
  liveId.current = activeId;

  useEffect(() => {
    if (!activeId) return;
    const forId = activeId;
    setQuerySets(null);
    listQuerySets(forId)
      .then((qs) => {
        if (liveId.current === forId) setQuerySets(qs);
      })
      .catch(() => {
        if (liveId.current === forId) setQuerySets([]);
      });
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    const forId = activeId;
    setWheel(cacheGet<SuggestionWheel>(`wheel.${forId}`));
    setWheelLoading(true);
    getSuggestions(forId)
      .then((w) => {
        cacheSet(`wheel.${forId}`, w);
        if (liveId.current === forId) setWheel(w);
      })
      .catch(() => {})
      .finally(() => {
        if (liveId.current === forId) setWheelLoading(false);
      });
  }, [activeId]);

  return { wheel, wheelLoading, querySets };
}
