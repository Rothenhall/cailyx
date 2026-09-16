'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { WorkList } from '@/components/patterns/WorkRow';
import { toWorkListItems } from '@/lib/work-mapping';
import { getWork, type WorkRow as WorkRowDto } from '@/services/operations';

/**
 * OP11 — My Work.
 *
 * design_plan.md §4.2: "Due/overdue/blocked work, list/board, filters, update
 * status, submit for review."
 *
 * This screen shows assigned work through the shared §3.3 `WorkList`, with the
 * backend's status vocabulary mapped centrally in `lib/work-mapping.ts` so
 * every work surface in the app agrees on what "done" means.
 *
 * §3.4 requires that below 768 px a work list becomes cards — `WorkList`
 * handles that itself, so this page does not branch on viewport.
 *
 * The empty state is chosen explicitly rather than defaulted: an empty result
 * here means "no work matches this scope", not "this project has no work",
 * and §3.5 gives those different copy. `no-results` is the honest one.
 */
export default function MyWorkPage() {
  const router = useRouter();
  const [rows, setRows] = useState<WorkRowDto[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const page = await getWork({ pageSize: 100 }, { signal });
      setRows(page.items);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="My Work" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!rows) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const overdue = rows.filter((row) => row.overdue).length;
  const blocked = rows.filter((row) => row.status === 'blocked').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Work"
        context={
          rows.length === 0
            ? 'Nothing assigned.'
            : [
                `${rows.length} item${rows.length === 1 ? '' : 's'}`,
                overdue > 0 ? `${overdue} overdue` : null,
                blocked > 0 ? `${blocked} blocked` : null,
              ]
                .filter(Boolean)
                .join(' · ')
        }
      />

      <Card>
        <CardContent className="pt-6">
          <WorkList
            items={toWorkListItems(rows)}
            onOpen={(item) => router.push(`/ops/work/${item.id}`)}
            // Not `no-results`: this list has no filters, so an empty result
            // means genuinely no assigned work, and telling the reader to
            // "clear the filters" would send them hunting for a control that
            // is not on the page.
            emptyState={<EmptyState variant="no-work" scope="mine" />}
            label="Assigned work"
          />
        </CardContent>
      </Card>
    </div>
  );
}
