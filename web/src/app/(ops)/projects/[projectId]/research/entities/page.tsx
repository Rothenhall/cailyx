'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
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
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import type { ApiError } from '@/lib/api';
import {
  ENTITY_TYPES,
  createEntity,
  getResearchScope,
  listEntities,
  parseJsonColumn,
  type EntityType,
  type EntityWithRecords,
  type ResearchScope,
  type SameAsVerification,
} from '@/services/research-library';

/**
 * EN01 — Entity registry.
 *
 * design_plan.md §4.3: *"Brand/product/founder/metric registry, canonical
 * names, schema/platform coverage"*.
 *
 * Two separations the table keeps, both from §1.5:
 *
 *  - **Entity consistency is not presence, and neither is a score.** The
 *    registry reports what each entity's published `sameAs` links do and how
 *    the platforms name it; it does not fold those into a completeness figure.
 *  - **`not-checked` is an answer.** A platform record nobody has compared
 *    stays `not-checked` — the shared rule in `entity-audit.consistency.ts`
 *    returns that rather than defaulting to a verdict, and the table shows it
 *    in the `unmeasured` tone.
 *
 * Provenance is per column rather than per row, because the three columns come
 * from three different kinds of source: the canonical name was asserted by an
 * operator, the schema check was measured off the live page, and the
 * consistency verdict is derived by comparing the two.
 */
const FILTER_DEFAULTS = { q: '', type: 'all', schema: 'all' };

export default function EntityRegistryPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [entities, setEntities] = useState<EntityWithRecords[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [result] = await Promise.all([
          listEntities(projectId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setEntities(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const rows = useMemo(() => {
    if (!entities) return [];
    const query = filters.q.trim().toLowerCase();
    return entities.filter((entity) => {
      if (filters.type !== 'all' && entity.type !== filters.type) return false;
      if (filters.schema !== 'all' && latestSchemaStatus(entity) !== filters.schema) return false;
      if (!query) return true;
      return [entity.name, entity.descriptor ?? '', entity.type]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [entities, filters]);

  const isFiltered = filters.q !== '' || filters.type !== 'all' || filters.schema !== 'all';

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entity of entities ?? []) counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
    return counts;
  }, [entities]);

  const columns: ReadonlyArray<ColumnDef<EntityWithRecords>> = [
    {
      key: 'name',
      header: 'Canonical name',
      accessor: (row) => row.name,
      sortable: true,
      width: 220,
      // The exact string every consistency check compares against.
      render: (row) => <span className="text-table font-medium">{row.name}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      accessor: (row) => row.type,
      sortable: true,
      width: 110,
      render: (row) => <span className="capitalize">{entityTypeLabel(row.type)}</span>,
    },
    {
      key: 'descriptor',
      header: 'Descriptor',
      accessor: (row) => row.descriptor ?? '',
      width: 240,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No descriptor recorded',
    },
    {
      key: 'schema',
      header: 'Schema check',
      accessor: (row) => latestSchemaStatus(row),
      sortable: true,
      width: 160,
      render: (row) => {
        const latest = row.schemaChecks[0];
        if (!latest) {
          return <ProvenanceBadge kind="unmeasured" label="Never checked" />;
        }
        return (
          <StatusPill
            label={schemaStatusLabel(latest.status)}
            tone={schemaStatusTone(latest.status)}
          />
        );
      },
    },
    {
      key: 'sameAs',
      header: 'sameAs links',
      accessor: (row) => latestSameAsTotal(row),
      sortable: true,
      align: 'right',
      width: 170,
      emptyLabel: 'Never checked',
      render: (row) => {
        const latest = row.schemaChecks[0];
        if (!latest) return null;
        const verifications = parseJsonColumn<SameAsVerification[]>(
          latest.sameAsVerification,
          'array',
        );
        if (!verifications) {
          return (
            <span className="text-meta text-unmeasured-foreground">
              {latest.sameAsCount} declared · verification not readable
            </span>
          );
        }
        const unresolved = verifications.filter((entry) => !entry.resolves).length;
        const unconfirmed = verifications.filter(
          (entry) => entry.resolves && entry.identityMatch !== true,
        ).length;
        return (
          <span className="text-meta">
            <span className="tabular-nums">{verifications.length}</span> declared
            {unresolved > 0 ? ` · ${unresolved} did not resolve` : ''}
            {unconfirmed > 0 ? ` · ${unconfirmed} unresolved identity` : ''}
          </span>
        );
      },
    },
    {
      key: 'platforms',
      header: 'Platform records',
      accessor: (row) => row.platformRecords.length,
      sortable: true,
      align: 'right',
      width: 190,
      render: (row) => {
        const mismatch = row.platformRecords.filter(
          (record) => record.consistencyStatus === 'mismatch',
        ).length;
        const unchecked = row.platformRecords.filter(
          (record) => record.consistencyStatus === 'not-checked',
        ).length;
        return (
          <span className="text-meta">
            <span className="tabular-nums">{row.platformRecords.length}</span> recorded
            {mismatch > 0 ? ` · ${mismatch} mismatch` : ''}
            {unchecked > 0 ? ` · ${unchecked} not checked` : ''}
          </span>
        );
      },
    },
    {
      key: 'createdAt',
      header: 'Added',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'open',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <a
          href={`/projects/${projectId}/research/entities/${row.id}`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Open entity
        </a>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Brand entities" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!entities) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          projectName: scope?.projectName,
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
          { label: 'Brand entities' },
        ]}
        title="Brand entities"
        context={`${entities.length} tracked entit${entities.length === 1 ? 'y' : 'ies'}`}
        primaryAction={{ label: 'Add entity', onClick: () => setCreateOpen(true) }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Registry by type</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ENTITY_TYPES.map((type) => (
              <div key={type} className="rounded-lg border border-border p-3">
                <dt className="text-meta font-medium text-foreground">{entityTypeLabel(type)}</dt>
                <dd className="mt-1 text-meta text-muted-foreground">
                  <span className="tabular-nums">{typeCounts.get(type) ?? 0}</span> tracked
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-meta text-muted-foreground">
            The name on each row is the <strong>canonical</strong> form: every consistency check
            compares a platform&rsquo;s recorded name against exactly this string. A descriptor
            never overrides the name — it is context, not identity.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Entities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <FilterBar
            defaults={FILTER_DEFAULTS}
            value={filters}
            onChange={setFilters}
            controls={[
              {
                kind: 'select',
                key: 'type',
                label: 'Type',
                allLabel: 'All types',
                options: ENTITY_TYPES.map((type) => ({ value: type, label: entityTypeLabel(type) })),
              },
              {
                kind: 'select',
                key: 'schema',
                label: 'Schema check',
                allLabel: 'Any schema state',
                options: [
                  { value: 'pass', label: 'Passed' },
                  { value: 'fail', label: 'Failed' },
                  { value: 'error', label: 'Errored' },
                  { value: 'never-checked', label: 'Never checked' },
                ],
              },
            ]}
            summary={`Showing ${rows.length} of ${entities.length}`}
          />

          <DataTable
            caption="Tracked entities"
            columns={columns}
            rows={rows}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'createdAt', direction: 'desc' }}
            minTableWidth="68rem"
            rowDetail={(row) => <EntityDetail row={row} />}
            emptyState={
              isFiltered ? (
                <EmptyState
                  variant="no-results"
                  onClearFilters={() => setFilters({ ...FILTER_DEFAULTS })}
                />
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="Entity consistency"
                  prerequisite="A registry needs at least one entity. Add the brand, its products, its founders and any named metric to compare across platforms."
                  action={{ label: 'Add entity', onClick: () => setCreateOpen(true) }}
                />
              )
            }
          />
        </CardContent>
      </Card>

      <p className="text-meta text-muted-foreground">
        Columns carry different provenance and are badged separately: the canonical name is
        operator-supplied, a schema check is measured off the live page, and the consistency verdict
        is derived by comparing the two. They are not summed — entity consistency, schema coverage
        and presence completeness measure different things over different populations (design_plan
        §1.5).
      </p>

      <CreateEntityDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={(created) => {
          setCreateOpen(false);
          setEntities((current) =>
            current ? [...current, { ...created, schemaChecks: [], platformRecords: [], modelDiffs: [] }] : current,
          );
        }}
        onError={setActionError}
      />
    </div>
  );
}

function EntityDetail({ row }: { row: EntityWithRecords }) {
  const latest = row.schemaChecks[0];
  const missing = latest
    ? parseJsonColumn<string[]>(latest.fieldsMissing, 'array')
    : null;

  return (
    <div className="space-y-3 text-table">
      <p className="text-muted-foreground">
        {row.descriptor ?? 'No descriptor recorded for this entity.'}
      </p>
      {!latest ? (
        <p className="text-unmeasured-foreground">
          No schema check has ever run for this entity, so no idea of its published structured data
          is available yet.
        </p>
      ) : (
        <div className="space-y-1">
          <p>
            <span className="text-muted-foreground">Last schema check:</span>{' '}
            <StatusPill
              label={schemaStatusLabel(latest.status)}
              tone={schemaStatusTone(latest.status)}
            />{' '}
            <Timestamp value={latest.checkedAt} />
          </p>
          <p className="text-meta">
            <span className="text-muted-foreground">Schema type:</span>{' '}
            {latest.schemaType ?? 'No JSON-LD type was found on the page.'}
          </p>
          {missing === null ? (
            <p className="text-meta text-unmeasured-foreground">
              The missing-field list could not be read from this check.
            </p>
          ) : missing.length > 0 ? (
            <p className="text-meta">
              <span className="text-muted-foreground">Missing required fields:</span>{' '}
              {missing.join(', ')}
            </p>
          ) : (
            <p className="text-meta text-muted-foreground">
              Every required field this check looks for was present.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CreateEntityDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: (entity: { id: string; name: string; descriptor: string | null; type: string; createdAt: string }) => void;
  onError: (error: ApiError) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<EntityType>('brand');
  const [descriptor, setDescriptor] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  async function submit() {
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createEntity(projectId, {
        name: name.trim(),
        type,
        descriptor: descriptor.trim() || undefined,
      });
      setName('');
      setDescriptor('');
      onCreated(created);
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add entity</DialogTitle>
          <DialogDescription>
            The name you give here becomes the canonical form the identity checks compare against.
            Enter it exactly as the brand should be named — &ldquo;Acme&rdquo; and &ldquo;Acme
            Ltd&rdquo; are treated as different names, on purpose.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Nothing was created." />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="en-name">Canonical name (required)</Label>
            <Input
              id="en-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              placeholder="e.g. Rothenhall Partners"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="en-type">Type (required)</Label>
            <Select value={type} onValueChange={(value) => setType(value as EntityType)}>
              <SelectTrigger id="en-type">
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
            <Label htmlFor="en-descriptor">Descriptor (optional)</Label>
            <Input
              id="en-descriptor"
              value={descriptor}
              onChange={(event) => setDescriptor(event.target.value)}
              maxLength={500}
              placeholder="One line on what this entity is"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || name.trim() === ''}>
            {submitting ? 'Adding…' : 'Add entity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function latestSchemaStatus(row: EntityWithRecords): string {
  return row.schemaChecks[0]?.status ?? 'never-checked';
}

function latestSameAsTotal(row: EntityWithRecords): number | null {
  const latest = row.schemaChecks[0];
  if (!latest) return null;
  const verifications = parseJsonColumn<SameAsVerification[]>(latest.sameAsVerification, 'array');
  return verifications ? verifications.length : latest.sameAsCount;
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
