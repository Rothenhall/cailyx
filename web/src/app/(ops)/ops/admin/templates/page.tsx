'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, Layers, Plus, Star } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  PROGRAM_ITEM_CATEGORIES,
  PROGRAM_ITEM_DISCIPLINES,
  PROGRAM_TEMPLATE_KINDS,
  REPORT_TYPES,
  createProgramTemplate,
  createReportTemplate,
  listProgramTemplates,
  listReportTemplates,
  setDefaultReportTemplate,
  updateProgramTemplate,
  type ProgramTemplate,
  type ProgramTemplateItem,
  type ProgramTemplateKind,
  type ReportTemplate,
  type ReportTemplateSection,
} from '@/services/admin';

/**
 * OP20 — Program templates.
 *
 * design_plan.md §4.2: *"Reusable onboarding/cycle/report checklists, SLAs,
 * responsible roles, revision history."*
 *
 * ## Two versioning models, and why the difference is shown
 *
 * `ReportTemplate` and `ProgramTemplate` are **mutated in place with a bumped
 * version counter**. A released report carries its own copy of the template and
 * the version it copied, which is what makes a pinned identity checkable
 * afterwards — but the *earlier content is not retrievable*. Organization
 * settings, on the same screen's sibling, are append-only and do keep every
 * version. Presenting a version counter as though it were a history would be a
 * lie, so this page says which model is in force and what it does not keep.
 *
 * ## What §4.2 asks for that this build does not have
 *
 * - **Per-template SLA.** No SLA field exists on either template type. The
 *   organization-wide review SLA lives in Organization settings and applies to
 *   reviews, not to checklists. It is reported as unavailable rather than drawn
 *   as an empty field.
 * - **Per-item due dates** exist, but only as an offset in days from an apply
 *   date. Without an apply date no date is written at all, and the field is
 *   labelled to say so.
 */

const KIND_LABEL: Record<string, string> = {
  onboarding: 'Onboarding',
  cycle: 'Delivery cycle',
  offboarding: 'Offboarding',
};

function TemplatesForbidden() {
  return (
    <EmptyState
      variant="insufficient-role"
      restrictedAction="read or change program and report templates"
      permittedPath="Ask an administrator. Your own work items and a project's report sections remain readable where you are assigned to the project."
    />
  );
}

export default function AdminTemplatesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Program templates"
        context="Reusable checklists for onboarding, delivery cycles and report layouts."
      />

      <Alert>
        <Info aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>How these templates version</AlertTitle>
        <AlertDescription>
          <p>
            Editing a template&rsquo;s content bumps its version counter on the
            same row. Rows already copied from an earlier version are{' '}
            <strong>copies, not references</strong>, so an edit cannot reach a
            committed cycle&rsquo;s scope — but the earlier version&rsquo;s
            content is not kept either. This is a different model from
            Organization settings, which is append-only and keeps every version.
          </p>
          <p className="mt-1">
            An SLA is not a field on either template type in this build. The
            organization-wide review SLA is set in Organization settings and
            applies to internal reviews, not to checklist items.
          </p>
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="program">
        <TabsList>
          <TabsTrigger value="program">Checklists</TabsTrigger>
          <TabsTrigger value="report">Report layouts</TabsTrigger>
        </TabsList>
        <TabsContent value="program" className="pt-4">
          <ProgramTemplates />
        </TabsContent>
        <TabsContent value="report" className="pt-4">
          <ReportTemplates />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Program templates ───────────────────────────────────────────────────

function ProgramTemplates() {
  const [templates, setTemplates] = useState<ProgramTemplate[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [editing, setEditing] = useState<ProgramTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const result = await listProgramTemplates(undefined, { signal });
      setTemplates(result.templates);
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

  async function toggleActive(template: ProgramTemplate) {
    setBusyId(template.id);
    setActionError(null);
    try {
      await updateProgramTemplate(template.id, { active: !template.active });
      await load();
    } catch (caught) {
      setActionError(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  const columns = useMemo<ReadonlyArray<ColumnDef<ProgramTemplate>>>(
    () => [
      {
        key: 'name',
        header: 'Template',
        accessor: (row) => row.name,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.name}</div>
            {row.description ? (
              <div className="truncate text-meta text-muted-foreground">{row.description}</div>
            ) : (
              <div className="text-meta text-muted-foreground">No description</div>
            )}
          </div>
        ),
      },
      {
        key: 'kind',
        header: 'Kind',
        accessor: (row) => row.kind,
        sortable: true,
        width: 150,
        render: (row) => <Badge variant="outline">{KIND_LABEL[row.kind] ?? row.kind}</Badge>,
      },
      {
        key: 'items',
        header: 'Items',
        accessor: (row) => row.items.length,
        sortable: true,
        align: 'right',
        width: 90,
        render: (row) => <span className="tabular-nums">{row.items.length}</span>,
      },
      {
        key: 'roles',
        header: 'Responsible roles',
        accessor: (row) => row.items.map((item) => item.role ?? '').filter(Boolean).join(', '),
        emptyLabel: 'No role assigned on any item',
        render: (row) => {
          const roles = [...new Set(row.items.map((item) => item.role).filter(Boolean))];
          if (roles.length === 0) {
            return (
              <span className="text-muted-foreground">
                No role assigned — nobody is named against these items
              </span>
            );
          }
          return <span>{roles.join(', ')}</span>;
        },
      },
      {
        key: 'version',
        header: 'Version',
        accessor: (row) => row.version,
        sortable: true,
        align: 'right',
        width: 100,
        render: (row) => <span className="tabular-nums font-medium">v{row.version}</span>,
      },
      {
        key: 'active',
        header: 'Status',
        accessor: (row) => (row.active ? 'active' : 'inactive'),
        sortable: true,
        width: 130,
        render: (row) =>
          row.active ? (
            <StatusPill label="Active" tone="success" />
          ) : (
            <StatusPill label="Inactive" tone="neutral" />
          ),
      },
      {
        key: 'updatedAt',
        header: 'Last changed',
        accessor: (row) => row.updatedAt,
        sortable: true,
        width: 200,
        render: (row) => <Timestamp value={row.updatedAt} />,
      },
      {
        key: 'actions',
        header: '',
        alwaysVisible: true,
        width: 200,
        align: 'right',
        render: (row) => (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busyId === row.id}
              onClick={() => void toggleActive(row)}
            >
              {row.active ? 'Deactivate' : 'Activate'}
            </Button>
          </div>
        ),
      },
    ],
    // `toggleActive` closes over `load`, which is stable; the dependency is the
    // busy id that changes the disabled state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId],
  );

  if (error) {
    // §3.5 "Insufficient role" — every organization template route is
    // `@Roles('admin')`, so a delivery lead who follows a copied link gets an
    // explanation rather than a failed fetch.
    if (error.kind === 'forbidden') return <TemplatesForbidden />;
    return <ErrorState error={error} onRetry={() => void load()} />;
  }

  if (!templates) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-table text-muted-foreground">
          Applying a template copies its rows into a project. Editing it
          afterwards cannot reach rows it has already produced.
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
          New checklist template
        </Button>
      </div>

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <DataTable
        caption="Program templates"
        columns={columns}
        rows={templates}
        getRowId={(row) => row.id}
        searchable
        searchPlaceholder="Search templates…"
        minTableWidth="72rem"
        defaultSort={{ key: 'kind', direction: 'asc' }}
        filters={[
          {
            id: 'kind',
            label: 'Kind',
            options: PROGRAM_TEMPLATE_KINDS.map((kind) => ({
              value: kind,
              label: KIND_LABEL[kind] ?? kind,
            })),
            getValue: (row) => row.kind,
          },
          {
            id: 'active',
            label: 'Status',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ],
            getValue: (row) => (row.active ? 'active' : 'inactive'),
          },
        ]}
        rowDetail={(row) => <ProgramItemList items={row.items} />}
        emptyState={
          <EmptyState
            variant="not-measured"
            subject="checklist templates"
            prerequisite="Creating one with the button above."
          >
            Nothing has been defined. Without a template, onboarding and cycle
            work has to be entered item by item.
          </EmptyState>
        }
      />

      <TemplateDialog
        open={creating || editing !== null}
        template={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

function ProgramItemList({ items }: { items: ProgramTemplateItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-table text-muted-foreground">
        This template has no items. Applying it would create nothing.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <h4 className="text-meta font-medium text-muted-foreground">
        Items, in the order they will be copied
      </h4>
      <ol className="space-y-2">
        {items.map((item, index) => (
          <li key={`${item.title}-${index}`} className="rounded-md border border-border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-table font-medium">
                {index + 1}. {item.title}
              </span>
              {item.category ? <Badge variant="outline">{item.category}</Badge> : null}
              {item.discipline ? <Badge variant="outline">{item.discipline}</Badge> : null}
            </div>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-meta sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Responsible role</dt>
                <dd>
                  {item.role ?? (
                    <span className="text-muted-foreground">Unassigned</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Estimate</dt>
                <dd>
                  {item.estimateHours === null ? (
                    <span className="text-muted-foreground">No estimate</span>
                  ) : (
                    `${item.estimateHours} h`
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Due offset</dt>
                <dd>
                  {item.offsetDays === null ? (
                    <span className="text-muted-foreground">No due date set</span>
                  ) : (
                    `${item.offsetDays} day${item.offsetDays === 1 ? '' : 's'} after the apply date`
                  )}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}

interface ItemDraft {
  title: string;
  category: string;
  discipline: string;
  role: string;
  estimateHours: string;
  offsetDays: string;
}

function blankItem(): ItemDraft {
  return { title: '', category: '', discipline: '', role: '', estimateHours: '', offsetDays: '' };
}

function TemplateDialog({
  open,
  template,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  template: ProgramTemplate | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProgramTemplateKind>('onboarding');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [items, setItems] = useState<ItemDraft[]>([blankItem()]);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed whenever the dialog opens for a different record, so an edit never
  // shows the previous template's values.
  useEffect(() => {
    if (!open) return;
    if (template) {
      setName(template.name);
      setKind(template.kind as ProgramTemplateKind);
      setDescription(template.description ?? '');
      setActive(template.active);
      setItems(
        template.items.length > 0
          ? template.items.map((item) => ({
              title: item.title,
              category: item.category ?? '',
              discipline: item.discipline ?? '',
              role: item.role ?? '',
              estimateHours: item.estimateHours === null ? '' : String(item.estimateHours),
              offsetDays: item.offsetDays === null ? '' : String(item.offsetDays),
            }))
          : [blankItem()],
      );
    } else {
      setName('');
      setKind('onboarding');
      setDescription('');
      setActive(true);
      setItems([blankItem()]);
    }
    setError(null);
  }, [open, template]);

  const namedItems = items.filter((item) => item.title.trim() !== '');

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      name,
      description: description.trim() === '' ? undefined : description,
      active,
      items: namedItems.map<ProgramTemplateItem>((item) => ({
        title: item.title.trim(),
        category: item.category === '' ? null : item.category,
        discipline: item.discipline === '' ? null : item.discipline,
        role: item.role.trim() === '' ? null : item.role.trim(),
        estimateHours: item.estimateHours.trim() === '' ? null : Number(item.estimateHours),
        offsetDays: item.offsetDays.trim() === '' ? null : Number(item.offsetDays),
      })),
    };
    try {
      if (template) {
        await updateProgramTemplate(template.id, payload);
      } else {
        await createProgramTemplate({ ...payload, kind });
      }
      onSaved();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{template ? `Edit ${template.name}` : 'New checklist template'}</DialogTitle>
          <DialogDescription>
            {template
              ? 'A content change bumps this template’s version. Rows already copied from it are untouched — they are copies.'
              : 'Starts at version 1. Inactive templates cannot be applied.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <ErrorState
              error={error}
              layout="inline"
              fieldIdPrefix="template-"
              preserveNotice="Nothing you entered has been cleared."
            />
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="template-name">
                Name <span className="text-muted-foreground">(required)</span>
              </Label>
              <Input
                id="template-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-kind">
                Kind <span className="text-muted-foreground">(required)</span>
              </Label>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as ProgramTemplateKind)}
                disabled={Boolean(template)}
              >
                <SelectTrigger id="template-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROGRAM_TEMPLATE_KINDS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {KIND_LABEL[option] ?? option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                {template
                  ? 'The kind is fixed after creation — it decides what a copy becomes.'
                  : kind === 'offboarding'
                    ? 'Offboarding has no target table in this build: applying it returns an explicit unavailable state rather than creating rows.'
                    : kind === 'cycle'
                      ? 'A cycle copy goes through the delivery plan, so a committed cycle still records scope additions rather than moving a frozen denominator.'
                      : 'An onboarding copy creates onboarding requests.'}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="template-description">Description</Label>
            <Textarea
              id="template-description"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <fieldset className="space-y-3">
            <legend className="text-table font-medium">Items</legend>
            <p className="text-meta text-muted-foreground">
              A due offset is measured in days from the date the template is
              applied. With no apply date, no due date is written.
            </p>
            <div className="space-y-3">
              {items.map((item, index) => (
                <div key={index} className="space-y-2 rounded-md border border-border p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Item ${index + 1} title`}
                      placeholder="What has to happen"
                      value={item.title}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = { ...item, title: event.target.value };
                        setItems(next);
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setItems(items.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-5">
                    <Select
                      value={item.category || 'none'}
                      onValueChange={(value) => {
                        const next = [...items];
                        next[index] = { ...item, category: value === 'none' ? '' : value };
                        setItems(next);
                      }}
                    >
                      <SelectTrigger aria-label={`Item ${index + 1} category`}>
                        <SelectValue placeholder="Category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No category</SelectItem>
                        {PROGRAM_ITEM_CATEGORIES.map((category) => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={item.discipline || 'none'}
                      onValueChange={(value) => {
                        const next = [...items];
                        next[index] = { ...item, discipline: value === 'none' ? '' : value };
                        setItems(next);
                      }}
                    >
                      <SelectTrigger aria-label={`Item ${index + 1} discipline`}>
                        <SelectValue placeholder="Discipline" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No discipline</SelectItem>
                        {PROGRAM_ITEM_DISCIPLINES.map((discipline) => (
                          <SelectItem key={discipline} value={discipline}>
                            {discipline}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label={`Item ${index + 1} responsible role`}
                      placeholder="Responsible role"
                      value={item.role}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = { ...item, role: event.target.value };
                        setItems(next);
                      }}
                    />
                    <Input
                      aria-label={`Item ${index + 1} estimate hours`}
                      type="number"
                      min={0}
                      step="0.5"
                      placeholder="Hours"
                      value={item.estimateHours}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = { ...item, estimateHours: event.target.value };
                        setItems(next);
                      }}
                    />
                    <Input
                      aria-label={`Item ${index + 1} due offset in days`}
                      type="number"
                      placeholder="Days after apply"
                      value={item.offsetDays}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = { ...item, offsetDays: event.target.value };
                        setItems(next);
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={items.length >= 200}
              onClick={() => setItems([...items, blankItem()])}
            >
              <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
              Add item
            </Button>
            {namedItems.length !== items.length ? (
              <p className="text-meta text-muted-foreground">
                {items.length - namedItems.length} row
                {items.length - namedItems.length === 1 ? '' : 's'} with no title
                will not be saved — an item with no title cannot be copied.
              </p>
            ) : null}
          </fieldset>

          <div className="flex items-start gap-3">
            <Switch id="template-active" checked={active} onCheckedChange={setActive} />
            <div>
              <Label htmlFor="template-active" className="text-table">
                Active
              </Label>
              <p className="text-meta text-muted-foreground">
                An inactive template is refused at apply time (409) rather than
                silently producing nothing.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ''}>
              {busy ? 'Saving…' : template ? 'Save template' : 'Create template'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Report templates ────────────────────────────────────────────────────

function ReportTemplates() {
  const [templates, setTemplates] = useState<ReportTemplate[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const result = await listReportTemplates(undefined, { signal });
      setTemplates(result.templates);
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

  async function makeDefault(template: ReportTemplate) {
    setBusyId(template.id);
    setActionError(null);
    try {
      await setDefaultReportTemplate(template.id);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  const columns = useMemo<ReadonlyArray<ColumnDef<ReportTemplate>>>(
    () => [
      {
        key: 'name',
        header: 'Template',
        accessor: (row) => row.name,
        sortable: true,
        render: (row) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.name}</span>
            {row.isDefault ? (
              <Badge variant="secondary">
                <Star aria-hidden="true" className="mr-1 h-3 w-3" />
                Default
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        key: 'reportType',
        header: 'Report type',
        accessor: (row) => row.reportType,
        sortable: true,
        width: 160,
      },
      {
        key: 'sections',
        header: 'Sections',
        accessor: (row) => row.sections.length,
        sortable: true,
        align: 'right',
        width: 110,
        render: (row) => (
          <span className="tabular-nums">
            {row.sections.filter((section) => section.include).length} of {row.sections.length}
          </span>
        ),
      },
      {
        key: 'version',
        header: 'Version',
        accessor: (row) => row.version,
        sortable: true,
        align: 'right',
        width: 100,
        render: (row) => <span className="tabular-nums font-medium">v{row.version}</span>,
      },
      {
        key: 'updatedAt',
        header: 'Last changed',
        accessor: (row) => row.updatedAt,
        sortable: true,
        width: 200,
        render: (row) => <Timestamp value={row.updatedAt} />,
      },
      {
        key: 'actions',
        header: '',
        alwaysVisible: true,
        width: 190,
        align: 'right',
        render: (row) =>
          row.isDefault ? (
            <span className="text-meta text-muted-foreground">
              Already the default for {row.reportType}
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busyId === row.id}
              onClick={() => void makeDefault(row)}
            >
              Make default
            </Button>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId],
  );

  if (error) {
    if (error.kind === 'forbidden') return <TemplatesForbidden />;
    return <ErrorState error={error} onRetry={() => void load()} />;
  }

  if (!templates) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-table text-muted-foreground">
          A report type uses its default template, or the most recently updated
          one when it has no default. Making a template the default clears the
          previous default of the same type — it does not change either
          version, only which is chosen.
        </p>
        <Button onClick={() => setCreating(true)}>
          <Layers aria-hidden="true" className="mr-2 h-4 w-4" />
          New report layout
        </Button>
      </div>

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <DataTable
        caption="Report templates"
        columns={columns}
        rows={templates}
        getRowId={(row) => row.id}
        searchable
        searchPlaceholder="Search report layouts…"
        defaultSort={{ key: 'name', direction: 'asc' }}
        filters={[
          {
            id: 'reportType',
            label: 'Report type',
            options: REPORT_TYPES.map((type) => ({ value: type, label: type })),
            getValue: (row) => row.reportType,
          },
        ]}
        rowDetail={(row) => <SectionList sections={row.sections} />}
        emptyState={
          <EmptyState
            variant="not-measured"
            subject="report templates"
            prerequisite="Creating one with the button above. Until then a report type has no configured layout and releases must disclose that."
          />
        }
      />

      <CreateReportTemplateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />
    </div>
  );
}

function SectionList({ sections }: { sections: ReportTemplateSection[] }) {
  const ordered = [...sections].sort((a, b) => a.order - b.order);
  if (ordered.length === 0) {
    return (
      <p className="text-table text-muted-foreground">
        This template lists no sections. A report generated from it would render
        an empty shell.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <h4 className="text-meta font-medium text-muted-foreground">
        Sections, in render order
      </h4>
      <ol className="space-y-1">
        {ordered.map((section) => (
          <li key={section.key} className="flex flex-wrap items-center gap-2 text-table">
            <span className="tabular-nums text-muted-foreground">{section.order}</span>
            <span className="font-medium">{section.title}</span>
            <span className="font-mono text-meta text-muted-foreground">{section.key}</span>
            <StatusPill
              label={section.include ? 'Included' : 'Excluded'}
              tone={section.include ? 'neutral' : 'unmeasured'}
            />
          </li>
        ))}
      </ol>
      <p className="text-meta text-muted-foreground">
        Section keys must be unique — a renderer keyed on them cannot tell two
        sections with the same key apart, and the server refuses a duplicate (409).
      </p>
    </div>
  );
}

function CreateReportTemplateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [reportType, setReportType] = useState<string>('monthly');
  const [isDefault, setIsDefault] = useState(false);
  const [sections, setSections] = useState<Array<{ key: string; title: string; order: string }>>([
    { key: '', title: '', order: '1' },
  ]);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  const named = sections.filter((section) => section.key.trim() !== '' && section.title.trim() !== '');
  const duplicateKeys =
    new Set(named.map((section) => section.key.trim())).size !== named.length;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createReportTemplate({
        name,
        reportType,
        isDefault,
        sections: named.map<ReportTemplateSection>((section, index) => ({
          key: section.key.trim(),
          title: section.title.trim(),
          include: true,
          order: section.order.trim() === '' ? index + 1 : Number(section.order),
        })),
      });
      setName('');
      setSections([{ key: '', title: '', order: '1' }]);
      onCreated();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New report layout</DialogTitle>
          <DialogDescription>
            Starts at version 1. A later edit that changes content bumps the
            version so a released report&rsquo;s pinned copy stays checkable.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <ErrorState
              error={error}
              layout="inline"
              fieldIdPrefix="report-template-"
              preserveNotice="Nothing you entered has been cleared."
            />
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="report-template-name">
                Name <span className="text-muted-foreground">(required)</span>
              </Label>
              <Input
                id="report-template-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-template-type">Report type</Label>
              <Select value={reportType} onValueChange={setReportType}>
                <SelectTrigger id="report-template-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-table font-medium">Sections</legend>
            <div className="space-y-2">
              {sections.map((section, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`Section ${index + 1} key`}
                    className="max-w-[12rem] font-mono"
                    placeholder="key"
                    value={section.key}
                    onChange={(event) => {
                      const next = [...sections];
                      next[index] = { ...section, key: event.target.value };
                      setSections(next);
                    }}
                  />
                  <Input
                    aria-label={`Section ${index + 1} title`}
                    className="max-w-[16rem]"
                    placeholder="Title as it renders"
                    value={section.title}
                    onChange={(event) => {
                      const next = [...sections];
                      next[index] = { ...section, title: event.target.value };
                      setSections(next);
                    }}
                  />
                  <Input
                    aria-label={`Section ${index + 1} order`}
                    type="number"
                    min={0}
                    className="max-w-[6rem]"
                    value={section.order}
                    onChange={(event) => {
                      const next = [...sections];
                      next[index] = { ...section, order: event.target.value };
                      setSections(next);
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={sections.length <= 1}
                    onClick={() => setSections(sections.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            {duplicateKeys ? (
              <p className="text-table text-warning">
                Two sections share a key. The server refuses this (409) — a
                renderer keyed on section keys cannot tell them apart.
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setSections([...sections, { key: '', title: '', order: String(sections.length + 1) }])
              }
            >
              <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
              Add section
            </Button>
          </fieldset>

          <div className="flex items-start gap-3">
            <Switch id="report-template-default" checked={isDefault} onCheckedChange={setIsDefault} />
            <div>
              <Label htmlFor="report-template-default" className="text-table">
                Make this the default layout for {reportType}
              </Label>
              <p className="text-meta text-muted-foreground">
                Clears the previous default of the same type in the same
                transaction, so a type never has two.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === '' || duplicateKeys}>
              {busy ? 'Creating…' : 'Create layout'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
