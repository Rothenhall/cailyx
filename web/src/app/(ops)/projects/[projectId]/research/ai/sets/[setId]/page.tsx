'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { GitBranch, Lock, Plus, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import type { ApiError } from '@/lib/api';
import {
  PROMPT_PERSONAS,
  PROMPT_PERSONA_LABEL,
  activateQuerySet,
  addQuerySetPrompt,
  forkQuerySet,
  getQuerySet,
  getResearchScope,
  parseJsonColumn,
  querySetProvenance,
  removeQuerySetPrompt,
  type FunnelStage,
  type QuerySet,
  type QuerySetItem,
  type ResearchScope,
} from '@/services/research-library';

/**
 * QS02 — Prompt set detail.
 *
 * design_plan.md §4.3: *"Items, funnel stages, add/remove draft prompt,
 * activate/fork, matrix-category views"*; §5.6 step 5: *"Draft prompt sets
 * accept add/remove, activation freezes them, fork creates the next draft
 * version. AEO-generated matrix metadata includes category, branding, register,
 * market and source context; generic add/remove endpoints do not provide a
 * complete metadata editor."*
 *
 * The versioning rule is enforced by the **server**, and this page renders what
 * the server actually does rather than what a screen would prefer:
 *
 *  - `POST /:setId/prompts` and `DELETE /:setId/prompts/:itemId` answer **409**
 *    on any set that is not a draft (`ensureDraft` in `query-set.service.ts`).
 *    So the add/remove controls do not exist on an active set — they are
 *    replaced by the reason and the fork action, rather than being rendered and
 *    then failing.
 *  - `POST /:setId/fork` answers **409** when the source *is* a draft. A draft
 *    is edited in place; there is nothing to fork yet.
 *
 * **What this page cannot show.** A measurement run stores the prompt-set
 * version it used (`AeoAudit.querySetId`), but no query-set route exposes the
 * reverse — which runs referenced this set. §4's "each number links to its
 * scoped evidence" therefore cannot be honoured from here, and the page says so
 * instead of implying the version is unattached.
 */
export default function PromptSetDetailPage() {
  const params = useParams<{ projectId: string; setId: string }>();
  const { projectId, setId } = params;

  const [set, setSet] = useState<QuerySet | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const [newPrompt, setNewPrompt] = useState('');
  const [newStage, setNewStage] = useState<FunnelStage>('problem-aware');
  const [adding, setAdding] = useState(false);

  const [confirmActivate, setConfirmActivate] = useState(false);
  const [forking, setForking] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<QuerySetItem | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [result] = await Promise.all([
          getQuerySet(projectId, setId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setSet(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, setId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Stable reference: the derivations below depend on it, not on `set`. */
  const items = useMemo(() => set?.items ?? [], [set]);
  const isDraft = set?.status === 'draft';

  const stageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.funnelStage, (counts.get(item.funnelStage) ?? 0) + 1);
    return counts;
  }, [items]);

  /** AEO matrix sets carry `dimension` + `meta`; hand-written sets carry neither. */
  const matrixRows = useMemo(
    () =>
      items
        .filter((item) => item.dimension !== null || item.meta !== null)
        .map((item) => ({
          item,
          meta: parseJsonColumn<Record<string, unknown>>(item.meta, 'object'),
        })),
    [items],
  );
  const matrixDimensions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of matrixRows) {
      const key = row.item.dimension ?? 'Category not set';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [matrixRows]);

  async function handleAdd() {
    const prompt = newPrompt.trim();
    if (!prompt) return;
    setAdding(true);
    setActionError(null);
    try {
      const created = await addQuerySetPrompt(projectId, setId, {
        prompt,
        funnelStage: newStage,
      });
      setSet((current) =>
        current ? { ...current, items: [...(current.items ?? []), created] } : current,
      );
      setNewPrompt('');
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(item: QuerySetItem) {
    setActionError(null);
    try {
      await removeQuerySetPrompt(projectId, setId, item.id);
      setSet((current) =>
        current
          ? { ...current, items: (current.items ?? []).filter((row) => row.id !== item.id) }
          : current,
      );
      setPendingRemoval(null);
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  async function handleActivate() {
    setActionError(null);
    try {
      const activated = await activateQuerySet(projectId, setId);
      setSet(activated);
      setConfirmActivate(false);
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  async function handleFork() {
    setForking(true);
    setActionError(null);
    try {
      const forked = await forkQuerySet(projectId, setId);
      window.location.assign(`/projects/${projectId}/research/ai/sets/${forked.id}`);
    } catch (caught) {
      setActionError(toApiError(caught));
      setForking(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Prompt set" />
        <ErrorState
          error={error}
          notFoundReason="missing-or-private"
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (!set) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const provenance = querySetProvenance(set.source);
  const setTitle = `${PROMPT_PERSONA_LABEL[set.persona] ?? set.persona} · v${set.version}`;

  const columns: ReadonlyArray<ColumnDef<QuerySetItem>> = [
    {
      key: 'prompt',
      header: 'Prompt',
      accessor: (row) => row.prompt,
      sortable: true,
      cellClassName: 'whitespace-normal',
      // The prompt is the row's identity, so it renders as escaped text —
      // never as markup (§10.5). React escapes by default; there is no
      // dangerouslySetInnerHTML anywhere in this file.
      render: (row) => <span className="text-table">{row.prompt}</span>,
    },
    {
      key: 'funnelStage',
      header: 'Funnel stage',
      accessor: (row) => PROMPT_PERSONA_LABEL[row.funnelStage] ?? row.funnelStage,
      sortable: true,
      width: 160,
    },
    {
      key: 'dimension',
      header: 'Matrix category',
      accessor: (row) => row.dimension,
      sortable: true,
      width: 190,
      // A hand-written prompt has no matrix category. That is an absence of
      // matrix metadata, not an empty cell to be read as "no category".
      emptyLabel: 'No matrix metadata',
    },
    {
      key: 'createdAt',
      header: 'Added',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 200,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    ...(isDraft
      ? ([
          {
            key: 'remove',
            header: '',
            width: 110,
            alwaysVisible: true,
            render: (row: QuerySetItem) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingRemoval(row)}
                aria-label={`Remove prompt: ${row.prompt.slice(0, 60)}`}
              >
                Remove
              </Button>
            ),
          },
        ] satisfies ReadonlyArray<ColumnDef<QuerySetItem>>)
      : []),
  ];

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          projectName: scope?.projectName,
          runLabel: `Prompt set ${setTitle}`,
          mode: 'live',
        }}
      />
      {scopeReadFailed ? (
        <p className="text-meta text-muted-foreground">
          The project context could not be read, so the client and domain are not shown above.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'AI visibility', href: `/projects/${projectId}/research/ai` }, { label: 'Question sets', href: `/projects/${projectId}/research/ai/sets` },
          { label: `v${set.version}` },
        ]}
        title={setTitle}
        context={
          <>
            {set.label ?? 'No label'} · {items.length} prompt{items.length === 1 ? '' : 's'}
            {set.activatedAt ? (
              <>
                {' · activated '}
                <Timestamp value={set.activatedAt} />
              </>
            ) : null}
          </>
        }
        status={
          <>
            <StatusPill label={setStatusLabel(set.status)} tone={setStatusTone(set.status)} />
            <ProvenanceBadge kind={provenance.kind} label={provenance.label} />
          </>
        }
        primaryAction={
          isDraft
            ? {
                label: 'Activate this version',
                onClick: () => setConfirmActivate(true),
                disabled: items.length === 0,
                disabledReason:
                  'An empty set cannot be activated — the server rejects a version with no prompts.',
              }
            : {
                label: forking ? 'Forking…' : `Fork to v${set.version + 1}`,
                onClick: () => void handleFork(),
                disabled: forking,
              }
        }
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <ErrorState
          error={actionError}
          layout="inline"
          preserveNotice="Your edits above are unchanged on this page."
          onRetry={() => {
            setActionError(null);
            void load();
          }}
        />
      ) : null}

      <Alert>
        {isDraft ? (
          <>
            <Plus aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Draft — editable in place</AlertTitle>
            <AlertDescription>
              Prompts can be added and removed while this version is a draft. Activating it freezes
              exactly these {items.length} prompt{items.length === 1 ? '' : 's'} as the version a
              measurement run references; after that, any change is a fork to v{set.version + 1}.
            </AlertDescription>
          </>
        ) : (
          <>
            <Lock aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Frozen at v{set.version} — editing goes through a fork</AlertTitle>
            <AlertDescription>
              The server rejects add and remove on a set that is not a draft, so those controls are
              not offered here. Forking copies every prompt into a new draft at v{set.version + 1};
              the activated version keeps measuring unchanged in the meantime.
            </AlertDescription>
          </>
        )}
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Funnel stages</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {items.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="Funnel-stage distribution"
              prerequisite="The distribution is counted over this version's prompts, and this version has none yet."
              layout="inline"
            />
          ) : (
            <ul className="flex flex-wrap gap-x-6 gap-y-2">
              {PROMPT_PERSONAS.map((stage) => {
                const count = stageCounts.get(stage) ?? 0;
                return (
                  <li key={stage} className="text-table">
                    <span className="text-muted-foreground">
                      {PROMPT_PERSONA_LABEL[stage] ?? stage}:
                    </span>{' '}
                    <span className="tabular-nums">
                      {count === 0 ? 'none in this version' : count}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Matrix categories</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {matrixRows.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="Matrix category metadata"
              prerequisite="Only a set generated from an AEO matrix carries a category, branding, register and market context per prompt. This set was written by hand, so it has none."
              layout="inline"
            />
          ) : (
            <>
              <ul className="flex flex-wrap gap-x-6 gap-y-2">
                {matrixDimensions.map(([dimension, count]) => (
                  <li key={dimension} className="text-table">
                    <span className="text-muted-foreground">{dimension}:</span>{' '}
                    <span className="tabular-nums">{count}</span>
                  </li>
                ))}
              </ul>
              <p className="text-meta text-muted-foreground">
                {matrixRows.length} of {items.length} prompt
                {items.length === 1 ? '' : 's'} carry matrix metadata. The generated context
                (category, branding, register, market, source) is shown per prompt in the row
                detail — the generic add/remove endpoints offer no editor for it, so it is
                read-only here.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {isDraft ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Add a prompt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="qs-new-prompt">Prompt</Label>
              <Input
                id="qs-new-prompt"
                value={newPrompt}
                onChange={(event) => setNewPrompt(event.target.value)}
                placeholder="The buyer question, in the words a buyer would type"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleAdd();
                  }
                }}
              />
              <p className="text-meta text-muted-foreground">
                Required: the prompt text. Funnel stage defaults to problem aware.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="qs-new-stage">Funnel stage</Label>
              <Select value={newStage} onValueChange={(value) => setNewStage(value as FunnelStage)}>
                <SelectTrigger id="qs-new-stage" className="max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROMPT_PERSONAS.map((stage) => (
                    <SelectItem key={stage} value={stage}>
                      {PROMPT_PERSONA_LABEL[stage] ?? stage}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void handleAdd()} disabled={adding || newPrompt.trim() === ''}>
              {adding ? 'Adding…' : 'Add prompt'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Prompts</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption={`Prompts in version ${set.version}`}
            columns={columns}
            rows={items}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'createdAt', direction: 'asc' }}
            searchable
            minTableWidth="60rem"
            rowDetail={(row) => <PromptDetail row={row} />}
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="Prompts in this version"
                prerequisite={
                  isDraft
                    ? 'Add the first prompt above. A version needs at least one before it can be activated.'
                    : 'This version holds no prompts.'
                }
              />
            }
          />
        </CardContent>
      </Card>

      <p className="text-meta text-muted-foreground">
        Which measurement runs referenced this exact version is not exposed by the query-set API —
        a run stores the version it used, but there is no reverse lookup from here. The version a
        run measured is visible on that run.
      </p>

      <ConfirmDialog
        open={confirmActivate}
        onOpenChange={setConfirmActivate}
        title={`Activate ${setTitle}`}
        confirmLabel="Activate this version"
        targetLabel="Prompt set"
        target={`${PROMPT_PERSONA_LABEL[set.persona] ?? set.persona} v${set.version}`}
        effect={
          <>
            This version becomes <strong>immutable</strong>. Every prompt in it is frozen exactly as
            listed here, and any later change has to be a fork into v{set.version + 1}.
          </>
        }
        scope={
          <>
            Measurement runs that reference this set will use exactly these {items.length} prompt
            {items.length === 1 ? '' : 's'}. The activated version keeps working until a new version
            is activated in its place.
          </>
        }
        onConfirm={handleActivate}
        onConfirmed={() => setConfirmActivate(false)}
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title="Remove prompt from draft"
        confirmLabel="Remove prompt"
        destructive
        targetLabel="Prompt"
        target={pendingRemoval?.prompt ?? ''}
        effect={
          <>
            The prompt is deleted from this draft version. Nothing else changes — the draft is still
            a draft, and removing it cannot be undone from this screen.
          </>
        }
        scope={<>Only this draft is affected. Activated versions keep their own copy of the prompts.</>}
        onConfirm={async () => {
          if (pendingRemoval) await handleRemove(pendingRemoval);
        }}
      />
    </div>
  );
}

/** The per-prompt matrix context, when the set was generated from a matrix. */
function PromptDetail({ row }: { row: QuerySetItem }) {
  const meta = parseJsonColumn<Record<string, unknown>>(row.meta, 'object');
  const entries = meta ? Object.entries(meta).filter(([, value]) => value !== null && value !== '') : [];

  return (
    <div className="space-y-3 text-table">
      <div>
        <h4 className="text-meta font-medium text-foreground">Prompt text (verbatim)</h4>
        <p className="evidence mt-1">{row.prompt}</p>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-meta sm:grid-cols-2">
        <div>
          <dt className="inline text-muted-foreground">Funnel stage: </dt>
          <dd className="inline">
            {PROMPT_PERSONA_LABEL[row.funnelStage] ?? row.funnelStage}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Matrix category: </dt>
          <dd className="inline">{row.dimension ?? 'No matrix metadata on this prompt'}</dd>
        </div>
      </dl>
      {entries.length > 0 ? (
        <div>
          <h4 className="text-meta font-medium text-foreground">Generated context</h4>
          <dl className="mt-1 grid gap-x-6 gap-y-1 text-meta sm:grid-cols-2">
            {entries.map(([key, value]) => (
              <div key={key}>
                <dt className="inline text-muted-foreground">{key}: </dt>
                <dd className="inline">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      <p className="text-meta text-muted-foreground">
        <GitBranch aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
        Added <Timestamp value={row.createdAt} />
      </p>
    </div>
  );
}

function setStatusTone(status: string): StatusTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'info';
    case 'archived':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function setStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'draft':
      return 'Draft';
    case 'archived':
      return 'Archived';
    default:
      return `Unrecognized: ${status}`;
  }
}
