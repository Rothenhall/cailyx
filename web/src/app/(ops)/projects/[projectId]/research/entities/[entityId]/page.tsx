'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import type { ApiError } from '@/lib/api';
import {
  ENTITY_TYPES,
  createPlatformRecord,
  deletePlatformRecord,
  getEntity,
  getPlatformConsistency,
  getResearchScope,
  listModelDiffs,
  listSchemaChecks,
  parseJsonColumn,
  runModelDiff,
  runSchemaCheck,
  updateEntity,
  updatePlatformRecord,
  type ConsistencyStatus,
  type EntityType,
  type EntityWithRecords,
  type ModelDiff,
  type PlatformConsistencyCheck,
  type PlatformRecord,
  type ResearchScope,
  type SameAsVerification,
  type SchemaCheck,
} from '@/services/research-library';

/**
 * EN02 — Entity detail.
 *
 * design_plan.md §4.3: *"Descriptor/type edit, sameAs checks, platform records,
 * consistency, model-diff history"*, in the run/evidence-detail family: *"sticky
 * scope/run header, status or comparison pair, section index, evidence table,
 * detail drawer; raw answer/check behind disclosure"*.
 *
 * The four panels are four different **kinds of claim**, and the page keeps
 * them apart rather than merging them into a "consistency" figure:
 *
 *  - **sameAs** is what the site's published JSON-LD declares, and whether each
 *    link actually resolves and names this entity. **Measured** off the live
 *    page.
 *  - **Platform records** are what a human recorded a platform as saying.
 *    **Operator-supplied**, or measured when the single-page verify fetch ran.
 *  - **Consistency** is the derived verdict from comparing the two, using the
 *    shared rules in `entity-audit.consistency.ts`. A stored `match`/`mismatch`
 *    always wins over a recomputed one; only `not-checked` falls through.
 *  - **Model diffs** are what keyed AI surfaces say when asked "What is
 *    {entity}?" — **model output**, badged as such and rendered as escaped text.
 *
 * There is no "sameAs editor" here on purpose. `sameAs` is read out of the
 * client's published markup; editing it in Cailyx would create a local claim
 * that no crawler or answer engine can see.
 */
const TAB_DEFAULTS = { tab: 'schema' };

export default function EntityDetailPage() {
  const params = useParams<{ projectId: string; entityId: string }>();
  const { projectId, entityId } = params;

  const [entity, setEntity] = useState<EntityWithRecords | null>(null);
  const [checks, setChecks] = useState<SchemaCheck[] | null>(null);
  const [consistency, setConsistency] = useState<PlatformConsistencyCheck[] | null>(null);
  const [diffs, setDiffs] = useState<ModelDiff[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const [tabState, setTabState] = useUrlState(TAB_DEFAULTS);
  const tab = tabState.tab;

  const [editOpen, setEditOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState<PlatformRecord | null>(null);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PlatformRecord | null>(null);
  const [modelDiffOpen, setModelDiffOpen] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [entityResult, checksResult, consistencyResult, diffsResult] = await Promise.all([
          getEntity(projectId, entityId, { signal }),
          listSchemaChecks(projectId, entityId, { signal, limit: 20 }),
          getPlatformConsistency(projectId, entityId, { signal }),
          listModelDiffs(projectId, entityId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setEntity(entityResult);
        setChecks(checksResult);
        setConsistency(consistencyResult);
        setDiffs(diffsResult);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, entityId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleDeleteRecord(record: PlatformRecord) {
    setActionError(null);
    try {
      await deletePlatformRecord(projectId, entityId, record.id);
      setPendingDelete(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Entity" />
        <ErrorState error={error} notFoundReason="missing-or-private" onRetry={() => void load()} />
      </div>
    );
  }

  if (!entity) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const latestCheck = checks?.[0] ?? null;
  const verifications = latestCheck
    ? parseJsonColumn<SameAsVerification[]>(latestCheck.sameAsVerification, 'array')
    : null;

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          projectName: scope?.projectName,
          runLabel: `Entity: ${entity.name}`,
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
          { label: 'Brand entities', href: `/projects/${projectId}/research/entities` },
          { label: entity.name },
        ]}
        title={entity.name}
        context={
          <>
            {entityTypeLabel(entity.type)} · {entity.descriptor ?? 'No descriptor recorded'}
          </>
        }
        status={
          <>
            <ProvenanceBadge kind="operator-supplied" label="Canonical name" />
            <span className="text-meta text-muted-foreground">
              Added <Timestamp value={entity.createdAt} />
            </span>
          </>
        }
        primaryAction={{ label: 'Run schema check', onClick: () => setSchemaOpen(true) }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit entity
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Identity it is checked against</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-2 text-table">
          <p>
            <span className="text-muted-foreground">Canonical name:</span>{' '}
            <span className="font-medium">{entity.name}</span>
          </p>
          <p>
            <span className="text-muted-foreground">Descriptor:</span>{' '}
            {entity.descriptor ?? 'No descriptor recorded'}
          </p>
          <p className="text-meta text-muted-foreground">
            Consistency compares a platform&rsquo;s recorded name against the canonical name exactly,
            after lowercasing and trimming. A fetched page title is compared by containment instead,
            because a title is padded by the platform (&ldquo;Acme Ltd | LinkedIn&rdquo;). Both rules
            live in one shared module so this screen and the digital-presence screen cannot disagree
            about what a name match is.
          </p>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(value) => setTabState({ tab: value }, { push: true })}>
        <TabsList>
          <TabsTrigger value="schema">sameAs &amp; schema</TabsTrigger>
          <TabsTrigger value="records">Platform records</TabsTrigger>
          <TabsTrigger value="consistency">Consistency</TabsTrigger>
          <TabsTrigger value="models">Model diffs</TabsTrigger>
        </TabsList>

        <TabsContent value="schema" className="space-y-4">
          {!latestCheck ? (
            <Card>
              <CardContent className="pt-6">
                <EmptyState
                  variant="not-measured"
                  subject="Schema and sameAs verification"
                  prerequisite="Run a schema check against a page that publishes this entity's JSON-LD, usually the homepage or the about page."
                  action={{ label: 'Run schema check', onClick: () => setSchemaOpen(true) }}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">
                    Latest check · <Timestamp value={latestCheck.checkedAt} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pt-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill
                      label={schemaStatusLabel(latestCheck.status)}
                      tone={schemaStatusTone(latestCheck.status)}
                    />
                    <ProvenanceBadge kind="measured" label="Fetched from the live page" />
                    <span className="text-table">
                      <span className="text-muted-foreground">JSON-LD type:</span>{' '}
                      {latestCheck.schemaType ?? 'none found on the page'}
                    </span>
                  </div>

                  <FieldList
                    title="Required fields present"
                    raw={latestCheck.fieldsPresent}
                    emptyCopy="No required field was found on this check."
                  />
                  <FieldList
                    title="Required fields missing"
                    raw={latestCheck.fieldsMissing}
                    emptyCopy="Nothing required was missing on this check."
                  />

                  {latestCheck.recommendedFix ? (
                    <div>
                      <h4 className="text-meta font-medium text-foreground">Recommended fix</h4>
                      <p className="text-table text-muted-foreground">{latestCheck.recommendedFix}</p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">
                    sameAs links ({latestCheck.sameAsCount} declared)
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  {verifications === null ? (
                    <EmptyState
                      variant="not-measured"
                      subject="sameAs link verification"
                      prerequisite="This check stored a sameAs count but no verification results that could be read. Re-run the schema check to verify each link again."
                      layout="inline"
                    />
                  ) : verifications.length === 0 ? (
                    <p className="text-table text-muted-foreground">
                      The page declares no <code>sameAs</code> links, so there is nothing that ties
                      this entity to a profile elsewhere. That is an observation, not a failure.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-meta text-muted-foreground">
                        Each link is fetched and checked twice: does it resolve, and does what came
                        back actually name this entity? A walled profile is the routine outcome for
                        the platforms that matter most, so an unresolved link is reported with its
                        status code rather than treated as a fault.
                      </p>
                      <ul className="space-y-2">
                        {verifications.map((entry) => (
                          <li
                            key={entry.url}
                            className="rounded-lg border border-border p-3 text-table"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <SafeLink href={entry.url} />
                              <StatusPill
                                label={entry.resolves ? 'Resolved' : 'Did not resolve'}
                                tone={entry.resolves ? 'success' : 'unmeasured'}
                              />
                              <StatusPill
                                label={
                                  entry.identityMatch === true
                                    ? 'Names this entity'
                                    : entry.identityMatch === false
                                      ? 'Does not name this entity'
                                      : 'Identity not established'
                                }
                                tone={
                                  entry.identityMatch === true
                                    ? 'success'
                                    : entry.identityMatch === false
                                      ? 'warning'
                                      : 'unmeasured'
                                }
                              />
                              {entry.statusCode !== null ? (
                                <span className="text-meta text-muted-foreground">
                                  HTTP {entry.statusCode}
                                </span>
                              ) : null}
                            </div>
                            {entry.title ? (
                              <p className="mt-2 text-meta text-muted-foreground">
                                Page title: <span className="evidence">{entry.title}</span>
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Check history</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <SchemaCheckTable checks={checks ?? []} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="records" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Platform records</CardTitle>
              <Button size="sm" onClick={() => setNewRecordOpen(true)}>
                Record a platform
              </Button>
            </CardHeader>
            <CardContent className="pt-2">
              <PlatformRecordTable
                records={entity.platformRecords}
                onEdit={setRecordOpen}
                onDelete={setPendingDelete}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="consistency" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Consistency against the canonical name</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <ProvenanceBadge kind="derived" label="Derived from the records above" />
              <p className="text-meta text-muted-foreground">
                A stored <strong>match</strong> or <strong>mismatch</strong> always wins — it came
                from a human or from a real fetch, and recomputing over it would replace evidence
                with a guess. Only <strong>not-checked</strong> rows fall through to a comparison,
                and with nothing to compare they stay not-checked rather than defaulting to a
                verdict.
              </p>
              {!consistency || consistency.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="Platform consistency"
                  prerequisite="Record how at least one platform names this entity, then compare it against the canonical name."
                  layout="inline"
                />
              ) : (
                <ConsistencyTable checks={consistency} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="models" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Model identity diffs</CardTitle>
              <Button size="sm" onClick={() => setModelDiffOpen(true)}>
                Run identity check
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                Asks each configured AI surface &ldquo;What is {entity.name}?&rdquo; and runs a
                judge pass for divergence. The answers are model output, not measurements, and are
                shown as raw text.
              </p>
              {!diffs || diffs.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="Model identity diffs"
                  prerequisite="No identity check has been run for this entity yet, so nothing is known about how models describe it."
                  action={{ label: 'Run identity check', onClick: () => setModelDiffOpen(true) }}
                  layout="inline"
                />
              ) : (
                <ul className="space-y-3">
                  {diffs.map((diff) => (
                    <li key={diff.id} className="rounded-lg border border-border p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill label={diff.status} tone={modelDiffTone(diff.status)} />
                        <ProvenanceBadge kind="model-interpretation" label={diff.provider} />
                        <span className="text-meta text-muted-foreground">
                          <Timestamp value={diff.createdAt} /> · {diff.model ?? 'model not recorded'}{' '}
                          · <span className="tabular-nums">{diff.latencyMs} ms</span>
                        </span>
                      </div>
                      <p className="text-meta text-muted-foreground">
                        Prompt: <span className="evidence">{diff.prompt}</span>
                      </p>
                      {diff.rawAnswer ? (
                        <div>
                          <h4 className="text-meta font-medium text-foreground">Raw answer</h4>
                          {/* Escaped text only — model output never becomes markup (§10.5). */}
                          <p className="evidence mt-1 max-h-64 overflow-auto">{diff.rawAnswer}</p>
                        </div>
                      ) : (
                        <p className="text-meta text-unmeasured-foreground">
                          No answer text was stored for this run.
                        </p>
                      )}
                      {diff.divergence ? (
                        <p className="text-meta">
                          <span className="text-muted-foreground">Divergence verdict:</span>{' '}
                          {diff.divergence}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <EditEntityDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={projectId}
        entity={entity}
        onSaved={(updated) => {
          setEditOpen(false);
          setEntity((current) => (current ? { ...current, ...updated } : current));
        }}
        onError={setActionError}
      />

      <SchemaCheckDialog
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        projectId={projectId}
        entityId={entityId}
        entityName={entity.name}
        onDone={() => {
          setSchemaOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <PlatformRecordDialog
        open={newRecordOpen}
        onOpenChange={setNewRecordOpen}
        projectId={projectId}
        entityId={entityId}
        record={null}
        onSaved={() => {
          setNewRecordOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <PlatformRecordDialog
        open={recordOpen !== null}
        onOpenChange={(open) => {
          if (!open) setRecordOpen(null);
        }}
        projectId={projectId}
        entityId={entityId}
        record={recordOpen}
        onSaved={() => {
          setRecordOpen(null);
          void load();
        }}
        onError={setActionError}
      />

      <ModelDiffDialog
        open={modelDiffOpen}
        onOpenChange={setModelDiffOpen}
        projectId={projectId}
        entityId={entityId}
        entityName={entity.name}
        onDone={() => {
          setModelDiffOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete platform record"
        confirmLabel="Delete platform record"
        destructive
        targetLabel="Record"
        target={
          pendingDelete
            ? `${pendingDelete.platform} — ${pendingDelete.recordedName ?? 'no recorded name'}`
            : ''
        }
        effect={
          <>
            The record of how this platform describes the entity is removed. It cannot be undone
            from this screen; re-recording it means entering the details again.
          </>
        }
        scope={<>Only this entity is affected. Nothing changes on the platform itself.</>}
        onConfirm={async () => {
          if (pendingDelete) await handleDeleteRecord(pendingDelete);
        }}
        onReload={() => void load()}
      />
    </div>
  );
}

function SafeLink({ href }: { href: string }) {
  const isSafe = href.startsWith('/') || /^https?:\/\//i.test(href);
  if (!isSafe) {
    return (
      <span className="evidence">
        {href} (not a link: unsupported URL scheme)
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-table break-all text-primary underline-offset-4 hover:underline"
    >
      <ExternalLink aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
      {href}
    </a>
  );
}

function FieldList({
  title,
  raw,
  emptyCopy,
}: {
  title: string;
  raw: string | null;
  emptyCopy: string;
}) {
  const values = parseJsonColumn<string[]>(raw, 'array');
  return (
    <div>
      <h4 className="text-meta font-medium text-foreground">{title}</h4>
      {values === null ? (
        <p className="text-meta text-unmeasured-foreground">
          This check&rsquo;s field list could not be read.
        </p>
      ) : values.length === 0 ? (
        <p className="text-meta text-muted-foreground">{emptyCopy}</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta">
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SchemaCheckTable({ checks }: { checks: SchemaCheck[] }) {
  const columns: ReadonlyArray<ColumnDef<SchemaCheck>> = [
    {
      key: 'checkedAt',
      header: 'Checked',
      accessor: (row) => row.checkedAt,
      sortable: true,
      width: 210,
      render: (row) => <Timestamp value={row.checkedAt} />,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => (
        <StatusPill label={schemaStatusLabel(row.status)} tone={schemaStatusTone(row.status)} />
      ),
    },
    {
      key: 'schemaType',
      header: 'JSON-LD type',
      accessor: (row) => row.schemaType,
      emptyLabel: 'None found',
    },
    {
      key: 'missing',
      header: 'Missing fields',
      accessor: (row) => parseJsonColumn<string[]>(row.fieldsMissing, 'array')?.length ?? null,
      align: 'right',
      width: 140,
      emptyLabel: 'Not readable',
      render: (row) => {
        const values = parseJsonColumn<string[]>(row.fieldsMissing, 'array');
        if (values === null) return null;
        return (
          <span className="tabular-nums">
            {values.length === 0 ? 'none' : values.join(', ')}
          </span>
        );
      },
    },
    {
      key: 'sameAs',
      header: 'sameAs',
      accessor: (row) => row.sameAsCount,
      sortable: true,
      align: 'right',
      width: 100,
    },
  ];

  return (
    <DataTable
      caption="Schema check history"
      columns={columns}
      rows={checks}
      getRowId={(row) => row.id ?? `${row.entityId}-${row.checkedAt}`}
      defaultSort={{ key: 'checkedAt', direction: 'desc' }}
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Schema check history"
          prerequisite="Run a check and its result is stored here, newest first."
          layout="inline"
        />
      }
    />
  );
}

function PlatformRecordTable({
  records,
  onEdit,
  onDelete,
}: {
  records: PlatformRecord[];
  onEdit: (record: PlatformRecord) => void;
  onDelete: (record: PlatformRecord) => void;
}) {
  const columns: ReadonlyArray<ColumnDef<PlatformRecord>> = [
    {
      key: 'platform',
      header: 'Platform',
      accessor: (row) => row.platform,
      sortable: true,
      width: 140,
      render: (row) => <span className="capitalize">{row.platform}</span>,
    },
    {
      key: 'recordedName',
      header: 'Name as recorded',
      accessor: (row) => row.recordedName,
      cellClassName: 'whitespace-normal',
      // Nothing was recorded, which is different from a name that is empty.
      emptyLabel: 'Not recorded',
    },
    {
      key: 'consistency',
      header: 'Consistency',
      accessor: (row) => row.consistencyStatus,
      sortable: true,
      width: 150,
      render: (row) => (
        <StatusPill
          label={consistencyLabel(row.consistencyStatus)}
          tone={consistencyTone(row.consistencyStatus)}
        />
      ),
    },
    {
      key: 'sourceUrl',
      header: 'Source',
      accessor: (row) => row.sourceUrl,
      width: 260,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No source URL',
      render: (row) => (row.sourceUrl ? <SafeLink href={row.sourceUrl} /> : null),
    },
    {
      key: 'createdAt',
      header: 'Recorded',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'actions',
      header: '',
      width: 170,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onEdit(row)}>
            Correct
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete(row)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      caption="Platform records"
      columns={columns}
      rows={records}
      getRowId={(row) => row.id}
      defaultSort={{ key: 'platform', direction: 'asc' }}
      minTableWidth="62rem"
      searchable
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Platform records"
          prerequisite="Nothing has been recorded about how other platforms name this entity, so no consistency comparison is possible yet."
          layout="inline"
        />
      }
    />
  );
}

function ConsistencyTable({ checks }: { checks: PlatformConsistencyCheck[] }) {
  const columns: ReadonlyArray<ColumnDef<PlatformConsistencyCheck>> = [
    {
      key: 'platform',
      header: 'Platform',
      accessor: (row) => row.platform,
      sortable: true,
      width: 140,
      render: (row) => <span className="capitalize">{row.platform}</span>,
    },
    {
      key: 'recordedName',
      header: 'Platform says',
      accessor: (row) => row.recordedName ?? '',
      emptyLabel: 'Nothing recorded to compare',
    },
    {
      key: 'entityName',
      header: 'Canonical name',
      accessor: (row) => row.entityName,
    },
    {
      key: 'verdict',
      header: 'Verdict',
      accessor: (row) => row.consistencyStatus,
      sortable: true,
      width: 150,
      render: (row) => (
        <StatusPill
          label={consistencyLabel(row.consistencyStatus)}
          tone={consistencyTone(row.consistencyStatus)}
        />
      ),
    },
    {
      key: 'fetchedTitle',
      header: 'Fetched title',
      accessor: (row) => row.fetchedTitle ?? '',
      width: 260,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No fetch was made',
      render: (row) =>
        row.fetchedTitle ? <span className="evidence">{row.fetchedTitle}</span> : null,
    },
  ];

  return (
    <DataTable
      caption="Platform consistency"
      columns={columns}
      rows={checks}
      getRowId={(row) => `${row.platform}-${row.recordedName ?? 'none'}`}
      defaultSort={{ key: 'platform', direction: 'asc' }}
      minTableWidth="58rem"
    />
  );
}

function EditEntityDialog({
  open,
  onOpenChange,
  projectId,
  entity,
  onSaved,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  entity: EntityWithRecords;
  onSaved: (patch: { name: string; descriptor: string | null; type: string }) => void;
  onError: (error: ApiError) => void;
}) {
  const [name, setName] = useState(entity.name);
  const [descriptor, setDescriptor] = useState(entity.descriptor ?? '');
  const [type, setType] = useState<EntityType>(
    (ENTITY_TYPES as readonly string[]).includes(entity.type) ? (entity.type as EntityType) : 'brand',
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(entity.name);
    setDescriptor(entity.descriptor ?? '');
    setType((ENTITY_TYPES as readonly string[]).includes(entity.type) ? (entity.type as EntityType) : 'brand');
  }, [open, entity]);

  async function submit() {
    setSaving(true);
    setFormError(null);
    try {
      const updated = await updateEntity(projectId, entity.id, {
        name: name.trim(),
        descriptor: descriptor.trim(),
        type,
      });
      onSaved({
        name: updated.name,
        descriptor: updated.descriptor ?? null,
        type: updated.type,
      });
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit entity</DialogTitle>
          <DialogDescription>
            Changing the canonical name changes what every consistency verdict is compared against.
            Existing platform records are not rewritten — they will simply be re-judged against the
            new name.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Your edits are still here." />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="en2-name">Canonical name (required)</Label>
            <Input
              id="en2-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="en2-type">Type (required)</Label>
            <Select value={type} onValueChange={(value) => setType(value as EntityType)}>
              <SelectTrigger id="en2-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {entityTypeLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="en2-descriptor">Descriptor</Label>
            <Input
              id="en2-descriptor"
              value={descriptor}
              onChange={(event) => setDescriptor(event.target.value)}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || name.trim() === ''}>
            {saving ? 'Saving…' : 'Save entity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SchemaCheckDialog({
  open,
  onOpenChange,
  projectId,
  entityId,
  entityName,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  entityId: string;
  entityName: string;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [url, setUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<SchemaCheck | null>(null);

  async function submit() {
    setRunning(true);
    setFormError(null);
    setResult(null);
    try {
      const outcome = await runSchemaCheck(projectId, entityId, url.trim());
      setResult(outcome);
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        setFormError(null);
        setResult(null);
        if (!next) onDone();
        else onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run schema check</DialogTitle>
          <DialogDescription>
            Fetches the page, extracts its JSON-LD, validates the fields this check requires, and
            verifies each <code>sameAs</code> link resolves and names {entityName}. Limited to five
            checks a minute.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            fieldIdPrefix="en2-"
            providerName="the page being checked"
          />
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="en2-url">Page URL (required)</Label>
          <Input
            id="en2-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/about"
            inputMode="url"
          />
          <p className="text-meta text-muted-foreground">
            This is a read of the page as published. It never edits the site, and it does not deploy
            anything.
          </p>
        </div>

        {result ? (
          <Alert>
            <AlertTitle>Check completed</AlertTitle>
            <AlertDescription>
              <p className="text-table">
                {schemaStatusLabel(result.status)} ·{' '}
                <span className="tabular-nums">{result.sameAsCount}</span> sameAs link
                {result.sameAsCount === 1 ? '' : 's'} declared
              </p>
              <p className="mt-1 text-meta">
                The result is stored on the entity and is visible in the history below.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={running}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          <Button onClick={() => void submit()} disabled={running || url.trim() === ''}>
            {running ? 'Checking…' : 'Run check'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlatformRecordDialog({
  open,
  onOpenChange,
  projectId,
  entityId,
  record,
  onSaved,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  entityId: string;
  record: PlatformRecord | null;
  onSaved: () => void;
  onError: (error: ApiError) => void;
}) {
  const isEdit = record !== null;
  const [platform, setPlatform] = useState('linkedin');
  const [recordedName, setRecordedName] = useState('');
  const [recordedDescriptor, setRecordedDescriptor] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [consistencyStatus, setConsistencyStatus] = useState<ConsistencyStatus>('not-checked');
  const [verifySource, setVerifySource] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    setPlatform(record?.platform ?? 'linkedin');
    setRecordedName(record?.recordedName ?? '');
    setRecordedDescriptor(record?.recordedDescriptor ?? '');
    setSourceUrl(record?.sourceUrl ?? '');
    setConsistencyStatus(
      record && (record.consistencyStatus === 'match' || record.consistencyStatus === 'mismatch')
        ? record.consistencyStatus
        : 'not-checked',
    );
    setVerifySource(false);
    setFormError(null);
  }, [open, record]);

  async function submit() {
    setSaving(true);
    setFormError(null);
    try {
      if (isEdit && record) {
        await updatePlatformRecord(projectId, entityId, record.id, {
          platform,
          recordedName,
          recordedDescriptor,
          sourceUrl: sourceUrl.trim() || undefined,
          consistencyStatus,
        });
      } else {
        await createPlatformRecord(projectId, entityId, {
          platform,
          recordedName: recordedName.trim() || undefined,
          recordedDescriptor: recordedDescriptor.trim() || undefined,
          sourceUrl: sourceUrl.trim() || undefined,
          consistencyStatus,
          verifySource: verifySource && sourceUrl.trim() !== '',
        });
      }
      onSaved();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Correct platform record' : 'Record a platform'}</DialogTitle>
          <DialogDescription>
            Record what a platform says about this entity. This is a note of what you observed — it
            does not connect Cailyx to the platform, and nothing is published.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Your entries are still here." />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pr-platform">Platform (required)</Label>
            <Input
              id="pr-platform"
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
              maxLength={40}
              placeholder="linkedin, g2, crunchbase, clutch, other"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pr-name">Name as shown on the platform</Label>
            <Input
              id="pr-name"
              value={recordedName}
              onChange={(event) => setRecordedName(event.target.value)}
              maxLength={300}
              placeholder="Exactly as the platform renders it"
            />
            <p className="text-meta text-muted-foreground">
              Compared exactly against the canonical name, after lowercasing. Padding the name here
              to make it match would hide the drift this check exists to find.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pr-descriptor">Descriptor on the platform</Label>
            <Input
              id="pr-descriptor"
              value={recordedDescriptor}
              onChange={(event) => setRecordedDescriptor(event.target.value)}
              maxLength={1000}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pr-source">Source URL</Label>
            <Input
              id="pr-source"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://…"
              inputMode="url"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pr-consistency">Consistency</Label>
            <Select
              value={consistencyStatus}
              onValueChange={(value) => setConsistencyStatus(value as ConsistencyStatus)}
            >
              <SelectTrigger id="pr-consistency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="not-checked">Not checked</SelectItem>
                <SelectItem value="match">Match</SelectItem>
                <SelectItem value="mismatch">Mismatch</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!isEdit ? (
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <Label htmlFor="pr-verify">Verify against the source page</Label>
                <p className="mt-1 text-meta text-muted-foreground">
                  Fetches the source URL once and compares the page title against the entity name.
                  A title is padded by the platform, so this uses containment rather than equality.
                  Requires a source URL.
                </p>
              </div>
              <Switch
                id="pr-verify"
                checked={verifySource}
                onCheckedChange={setVerifySource}
                disabled={sourceUrl.trim() === ''}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || platform.trim() === ''}>
            {saving ? 'Saving…' : isEdit ? 'Save record' : 'Record platform'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelDiffDialog({
  open,
  onOpenChange,
  projectId,
  entityId,
  entityName,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  entityId: string;
  entityName: string;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  async function submit() {
    setRunning(true);
    setFormError(null);
    try {
      await runModelDiff(projectId, entityId, prompt.trim() || undefined);
      onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run model identity check</DialogTitle>
          <DialogDescription>
            Asks every configured AI surface the identity prompt for {entityName}, then judges
            whether their descriptions diverge. This spends provider credit, and it is not a
            measurement of visibility — it is a read of how models currently describe the entity.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            providerName="the AI surface provider"
            preserveNotice="Nothing was run."
          />
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="md-prompt">Identity prompt (optional)</Label>
          <Input
            id="md-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={`What is ${entityName}?`}
          />
          <p className="text-meta text-muted-foreground">
            Leave blank to use the default identity prompt.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={running}>
            {running ? 'Running…' : 'Run identity check'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function consistencyTone(status: string): StatusTone {
  switch (status) {
    case 'match':
      return 'success';
    case 'mismatch':
      return 'warning';
    case 'not-checked':
      return 'unmeasured';
    default:
      return 'unmeasured';
  }
}

function consistencyLabel(status: string): string {
  switch (status) {
    case 'match':
      return 'Match';
    case 'mismatch':
      return 'Mismatch';
    case 'not-checked':
      return 'Not checked';
    default:
      return `Unrecognized: ${status}`;
  }
}

function modelDiffTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'info';
    case 'error':
      return 'danger';
    case 'deferred':
    case 'not-run':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}

function entityTypeLabel(type: string): string {
  switch (type) {
    case 'brand':
      return 'Brand';
    case 'product':
      return 'Product';
    case 'founder':
      return 'Founder';
    case 'metric':
      return 'Metric';
    default:
      return `Unrecognized type: ${type}`;
  }
}

function schemaStatusTone(status: string): StatusTone {
  switch (status) {
    case 'pass':
      return 'success';
    case 'fail':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'unmeasured';
  }
}

function schemaStatusLabel(status: string): string {
  switch (status) {
    case 'pass':
      return 'Passed';
    case 'fail':
      return 'Failed';
    case 'error':
      return 'Errored';
    default:
      return `Unrecognized: ${status}`;
  }
}
