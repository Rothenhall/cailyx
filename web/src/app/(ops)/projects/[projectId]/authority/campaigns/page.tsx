'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, RefreshCw } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  MENTION_TARGET_STATUSES,
  MENTION_TARGET_STATUS_LABEL,
  MENTION_TARGET_TYPES,
  createMentionCampaign,
  createMentionTarget,
  listMentionCampaigns,
  listMentionTargets,
  type MentionCampaignWithCount,
  type MentionTargetStatus,
  type MentionTargetType,
  type MentionTargetWithLatestCheck,
} from '@/services/authority';

/**
 * AT02 — Outreach campaigns.
 *
 * design_plan.md §4.4: *"Campaign targets, status pipeline, listicle query,
 * create"*, and §5.9:
 *
 * > Outreach: create campaign; qualify URL/contact through human process;
 * > advance new → contacted → replied → placed/rejected; store notes. … Manual
 * > contact occurs outside Cailyx until G11 is chosen.
 *
 * Two rules this page keeps visible:
 *
 *  1. **A status is a human's record, not a system fact.** The pipeline is a
 *     ledger the operator maintains; nothing on this page is inferred from
 *     provider data. The badge on every target says the row was recorded by an
 *     operator, which is the difference §5.9 draws between a target and a
 *     discovered candidate.
 *  2. **Never checked ≠ checked and absent.** A target with no check has no
 *     mention evidence either way, and its column says so rather than showing
 *     a "not mentioned" reading it does not have. (AT04 is where that
 *     distinction is the whole point; it is not allowed to leak here.)
 */

const FILTER_DEFAULTS = {
  q: '',
  status: 'all',
  type: 'all',
  campaign: 'all',
};

const STATUS_FILTER_OPTIONS = MENTION_TARGET_STATUSES.map((status) => ({
  value: status,
  label: MENTION_TARGET_STATUS_LABEL[status],
}));

const TYPE_FILTER_OPTIONS = MENTION_TARGET_TYPES.map((type) => ({
  value: type,
  label: type.charAt(0).toUpperCase() + type.slice(1),
}));

export default function OutreachCampaignsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const [campaigns, setCampaigns] = useState<MentionCampaignWithCount[] | null>(null);
  const [targets, setTargets] = useState<MentionTargetWithLatestCheck[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [addingTarget, setAddingTarget] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [nextCampaigns, nextTargets] = await Promise.all([
          listMentionCampaigns(projectId, { signal }),
          listMentionTargets(projectId, undefined, { signal }),
        ]);
        setCampaigns(nextCampaigns);
        setTargets(nextTargets);
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

  const campaignOptions = useMemo(
    () => [
      { value: 'none', label: 'Not in a campaign' },
      ...(campaigns ?? []).map((campaign) => ({ value: campaign.id, label: campaign.name })),
    ],
    [campaigns],
  );

  const pipeline = useMemo(() => {
    const counts = new Map<string, number>();
    for (const status of MENTION_TARGET_STATUSES) counts.set(status, 0);
    for (const target of targets ?? []) {
      counts.set(target.status, (counts.get(target.status) ?? 0) + 1);
    }
    return counts;
  }, [targets]);

  const query = String(filters.q ?? '').trim().toLowerCase();
  const visibleTargets = useMemo(() => {
    return (targets ?? []).filter((target) => {
      if (filters.status !== 'all' && target.status !== filters.status) return false;
      if (filters.type !== 'all' && target.type !== filters.type) return false;
      if (filters.campaign !== 'all') {
        if (filters.campaign === 'none') {
          if (target.campaignId !== null) return false;
        } else if (target.campaignId !== filters.campaign) {
          return false;
        }
      }
      if (!query) return true;
      const haystack = [target.url, target.label ?? '', target.notes ?? '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [targets, filters.status, filters.type, filters.campaign, query]);

  const campaignById = useMemo(() => {
    const map = new Map<string, MentionCampaignWithCount>();
    for (const campaign of campaigns ?? []) map.set(campaign.id, campaign);
    return map;
  }, [campaigns]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Outreach campaigns" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!campaigns || !targets) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const targetColumns: ReadonlyArray<ColumnDef<MentionTargetWithLatestCheck>> = [
    {
      key: 'label',
      header: 'Target',
      accessor: (row) => row.label ?? row.url,
      sortable: true,
      render: (row) => (
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium text-foreground">{row.label ?? row.url}</div>
          <div className="truncate text-meta text-muted-foreground">{row.url}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      accessor: (row) => row.type,
      sortable: true,
      width: 120,
      render: (row) => <span className="capitalize">{row.type}</span>,
    },
    {
      key: 'campaign',
      header: 'Campaign',
      accessor: (row) => (row.campaignId ? campaignById.get(row.campaignId)?.name ?? '' : ''),
      width: 180,
      emptyLabel: 'Not in a campaign',
      render: (row) => {
        if (!row.campaignId) return null;
        const campaign = campaignById.get(row.campaignId);
        return campaign ? (
          campaign.name
        ) : (
          // The id resolves to nothing in the campaign list: say so rather
          // than rendering a blank cell that reads as "no campaign".
          <span className="text-muted-foreground">Campaign {row.campaignId} (not in the list)</span>
        );
      },
    },
    {
      key: 'status',
      header: 'Outreach status',
      accessor: (row) => row.status,
      sortable: true,
      width: 150,
      render: (row) => (
        <StatusPill
          label={MENTION_TARGET_STATUS_LABEL[row.status as MentionTargetStatus] ?? row.status}
          tone={outreachTone(row.status)}
        />
      ),
    },
    {
      key: 'latestCheck',
      header: 'Latest check',
      width: 230,
      render: (row) => <LatestCheckCell target={row} />,
    },
    {
      key: 'provenance',
      header: 'Recorded by',
      width: 170,
      render: () => <ProvenanceBadge kind="operator-supplied" />,
    },
    {
      key: 'open',
      header: '',
      width: 90,
      alwaysVisible: true,
      render: (row) => (
        <a
          href={`/projects/${projectId}/authority/targets/${row.id}`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Open
        </a>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Outreach campaigns"
        context={`${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} · ${targets.length} target${
          targets.length === 1 ? '' : 's'
        }`}
        primaryAction={{
          label: 'New campaign',
          icon: <Plus aria-hidden="true" className="h-4 w-4" />,
          onClick: () => setCreatingCampaign(true),
        }}
        secondaryActions={
          <>
            <Button variant="outline" size="sm" onClick={() => setAddingTarget(true)}>
              Add target
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      <p className="text-table text-muted-foreground">
        Contact happens outside Cailyx. This ledger records what was decided and what was
        found — advancing a status here does not send anything.
      </p>

      {/* ── Pipeline ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Pipeline</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {targets.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="outreach status"
              prerequisite="Add a target, or promote one from a discovery scan."
            />
          ) : (
            <ul className="flex flex-wrap gap-x-6 gap-y-3">
              {MENTION_TARGET_STATUSES.map((status) => (
                <li key={status} className="flex items-baseline gap-2">
                  <StatusPill
                    label={MENTION_TARGET_STATUS_LABEL[status]}
                    tone={outreachTone(status)}
                  />
                  <span className="text-subsection font-semibold tabular-nums">
                    {formatNumber(pipeline.get(status) ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Campaigns ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Campaigns</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {campaigns.length === 0 ? (
            <EmptyState variant="no-work" scope="project">
              <p>
                A campaign groups targets around one hunt query, for example the &ldquo;best X&rdquo;
                listicles you are pursuing. Create one to start grouping.
              </p>
            </EmptyState>
          ) : (
            <DataTable
              caption="Outreach campaigns"
              columns={[
                {
                  key: 'name',
                  header: 'Campaign',
                  accessor: (row) => row.name,
                  sortable: true,
                  render: (row) => <span className="font-medium">{row.name}</span>,
                },
                {
                  key: 'listicleQuery',
                  header: 'Hunt query',
                  accessor: (row) => row.listicleQuery,
                  width: 280,
                  emptyLabel: 'No query recorded',
                },
                {
                  key: 'targets',
                  header: 'Targets',
                  accessor: (row) => row._count?.targets ?? null,
                  sortable: true,
                  align: 'right',
                  width: 100,
                  render: (row) => (
                    <span className="tabular-nums">{formatNumber(row._count.targets)}</span>
                  ),
                },
                {
                  key: 'createdAt',
                  header: 'Created',
                  accessor: (row) => row.createdAt,
                  sortable: true,
                  width: 200,
                  render: (row) => <Timestamp value={row.createdAt} />,
                },
                {
                  key: 'view',
                  header: '',
                  width: 120,
                  alwaysVisible: true,
                  render: (row) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setFilters({ campaign: row.id })}
                    >
                      View targets
                    </Button>
                  ),
                },
              ]}
              rows={campaigns}
              getRowId={(row) => row.id}
              defaultSort={{ key: 'createdAt', direction: 'desc' }}
              emptyState={<EmptyState variant="no-results" />}
              minTableWidth="56rem"
            />
          )}
        </CardContent>
      </Card>

      {/* ── Targets ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Targets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          {targets.length === 0 ? (
            <EmptyState variant="no-work" scope="project">
              <p>
                Nothing is being tracked yet. Add a target by hand, or promote a candidate from the
                discovery screen — promotion creates the ledger record, and nothing is contacted.
              </p>
            </EmptyState>
          ) : (
            <>
              <FilterBar
                defaults={FILTER_DEFAULTS}
                value={filters}
                onChange={setFilters}
                controls={[
                  { kind: 'select', key: 'status', label: 'Status', options: STATUS_FILTER_OPTIONS },
                  { kind: 'select', key: 'type', label: 'Type', options: TYPE_FILTER_OPTIONS },
                  {
                    kind: 'select',
                    key: 'campaign',
                    label: 'Campaign',
                    options: campaignOptions,
                    allLabel: 'All campaigns',
                  },
                ]}
                searchPlaceholder="Search URL, label or notes"
                summary={`Showing ${visibleTargets.length} of ${targets.length}`}
              />
              <DataTable
                caption="Mention outreach targets"
                columns={targetColumns}
                rows={visibleTargets}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'label', direction: 'asc' }}
                emptyState={
                  <EmptyState
                    variant="no-results"
                    onClearFilters={() =>
                      setFilters({ q: '', status: 'all', type: 'all', campaign: 'all' })
                    }
                  />
                }
                minTableWidth="72rem"
              />
            </>
          )}
        </CardContent>
      </Card>

      <CreateCampaignDialog
        open={creatingCampaign}
        onOpenChange={setCreatingCampaign}
        projectId={projectId}
        onCreated={() => {
          setCreatingCampaign(false);
          void load();
        }}
      />

      <AddTargetDialog
        open={addingTarget}
        onOpenChange={setAddingTarget}
        projectId={projectId}
        campaigns={campaigns}
        defaultCampaignId={filters.campaign !== 'all' && filters.campaign !== 'none' ? filters.campaign : undefined}
        onCreated={() => {
          setAddingTarget(false);
          void load();
        }}
      />
    </div>
  );
}

/**
 * The latest check, or an explicit statement that there is none.
 *
 * The middle state matters: a check that ran and could not fetch the page
 * recorded `mentioned: false` with no HTTP status, and that is not the same
 * evidence as a page that answered without the brand on it.
 */
function LatestCheckCell({ target }: { target: MentionTargetWithLatestCheck }) {
  const check = target.latestCheck;
  if (!check) {
    return (
      <div className="space-y-0.5">
        <span className="text-meta text-muted-foreground">Never checked</span>
        <div className="text-meta text-muted-foreground">
          There is no finding either way for this target.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          label={check.mentioned ? 'Mention found' : 'Not on the page'}
          tone={check.mentioned ? 'success' : 'neutral'}
        />
        {check.httpStatus === null ? (
          <StatusPill label="Page could not be fetched" tone="warning" />
        ) : (
          <span className="text-meta text-muted-foreground">HTTP {check.httpStatus}</span>
        )}
      </div>
      <Timestamp value={check.checkedAt} />
    </div>
  );
}

function CreateCampaignDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [listicleQuery, setListicleQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  const nameTooShort = name.trim().length > 0 && name.trim().length < 2;

  async function submit() {
    setSubmitting(true);
    setFormError(null);
    try {
      await createMentionCampaign(projectId, {
        name: name.trim(),
        listicleQuery: listicleQuery.trim() || undefined,
      });
      setName('');
      setListicleQuery('');
      onCreated();
    } catch (caught) {
      setFormError(toApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            Groups targets that pursue the same thing. Creating one does not contact anyone.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Nothing was created." />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="campaign-name">
              Campaign name <span className="text-danger-foreground">(required)</span>
            </Label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Best-of listicles"
            />
            {nameTooShort ? (
              <p className="text-meta text-danger-foreground">
                A campaign name needs at least two characters.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="campaign-query">Hunt query</Label>
            <Input
              id="campaign-query"
              value={listicleQuery}
              onChange={(event) => setListicleQuery(event.target.value)}
              placeholder="best ai visibility tools"
            />
            <p className="text-meta text-muted-foreground">
              The &ldquo;best X&rdquo; phrase this campaign is chasing. Optional, and shown on the
              campaign row.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || name.trim().length < 2}
            aria-describedby={name.trim().length < 2 ? 'campaign-name-requirement' : undefined}
          >
            {submitting ? 'Creating…' : 'Create campaign'}
          </Button>
        </DialogFooter>
        {name.trim().length < 2 ? (
          <p id="campaign-name-requirement" className="text-meta text-muted-foreground">
            Enter a campaign name of at least two characters to create it.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AddTargetDialog({
  open,
  onOpenChange,
  projectId,
  campaigns,
  defaultCampaignId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  campaigns: MentionCampaignWithCount[];
  defaultCampaignId?: string;
  onCreated: () => void;
}) {
  const [url, setUrl] = useState('');
  const [type, setType] = useState<MentionTargetType>('listicle');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [campaignId, setCampaignId] = useState(defaultCampaignId ?? 'none');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  // Opening the dialog adopts whichever campaign the list is filtered to,
  // so "add a target to this campaign" does what it says.
  useEffect(() => {
    if (open) setCampaignId(defaultCampaignId ?? 'none');
  }, [open, defaultCampaignId]);

  const urlInvalid = url.trim().length > 0 && url.trim().length < 9;

  async function submit() {
    setSubmitting(true);
    setFormError(null);
    try {
      await createMentionTarget(projectId, {
        url: url.trim(),
        type,
        label: label.trim() || undefined,
        notes: notes.trim() || undefined,
        campaignId: campaignId === 'none' ? undefined : campaignId,
      });
      setUrl('');
      setLabel('');
      setNotes('');
      onCreated();
    } catch (caught) {
      setFormError(toApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a target</DialogTitle>
          <DialogDescription>
            Records a page worth pursuing so it can be tracked and checked. No check runs when it
            is saved.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState error={formError} layout="inline" preserveNotice="Nothing was recorded." />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="target-url">
              Page URL <span className="text-danger-foreground">(required)</span>
            </Label>
            <Input
              id="target-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://blog.example.com/best-ai-visibility-tools"
            />
            {urlInvalid ? (
              <p className="text-meta text-danger-foreground">
                A URL needs at least nine characters, including its scheme.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-type">Type</Label>
            <Select value={type} onValueChange={(value) => setType(value as MentionTargetType)}>
              <SelectTrigger id="target-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MENTION_TARGET_TYPES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-label">Label</Label>
            <Input
              id="target-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Page title or a human name for it"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-campaign">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger id="target-campaign">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not in a campaign</SelectItem>
                {campaigns.map((campaign) => (
                  <SelectItem key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-notes">Notes</Label>
            <Textarea
              id="target-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Who to approach, what was said, what was agreed"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || url.trim().length < 9}
            aria-describedby={url.trim().length < 9 ? 'target-url-requirement' : undefined}
          >
            {submitting ? 'Saving…' : 'Add target'}
          </Button>
        </DialogFooter>
        {url.trim().length < 9 ? (
          <p id="target-url-requirement" className="text-meta text-muted-foreground">
            Enter the page URL (at least nine characters) to save the target.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Outreach states are human bookkeeping: only "placed" is an outcome. */
function outreachTone(status: string): StatusTone {
  switch (status) {
    case 'placed':
      return 'success';
    case 'replied':
      return 'info';
    case 'rejected':
      return 'neutral';
    case 'contacted':
      return 'info';
    default:
      return 'neutral';
  }
}
