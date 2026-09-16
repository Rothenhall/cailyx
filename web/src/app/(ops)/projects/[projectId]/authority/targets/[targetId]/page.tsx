'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { ApiError } from '@/lib/api';
import {
  MENTION_DECAY_DAYS,
  MENTION_TARGET_STATUSES,
  MENTION_TARGET_STATUS_LABEL,
  checkMentionTarget,
  deleteMentionTarget,
  listMentionChecks,
  listMentionTargets,
  updateMentionTarget,
  type MentionCheck,
  type MentionTargetStatus,
  type MentionTargetWithLatestCheck,
} from '@/services/authority';

/**
 * AT03 — Outreach target.
 *
 * design_plan.md §4.4: *"URL, type/label/notes/status, latest mention and full
 * check history; check/remove"*, over §5.9's mention-maintenance rule:
 *
 * > check a target with the brand token, store finding/excerpt, inspect check
 * > history and decay. **A page containing the token is evidence of a mention,
 * > not proof of endorsement or referral revenue.**
 *
 * Four things this page refuses to blur:
 *
 *  1. **The brand token is an input, not a stored guess.** The check route
 *     requires it, so the page asks for one and says what it is used for. It is
 *     kept in the URL so a check can be reproduced from a link.
 *  2. **"Not on the page" and "the page could not be fetched" are different
 *     findings.** The backend records `mentioned: false` for both; only
 *     `httpStatus` separates them, so the page reads it and says which
 *     happened. A failed fetch is never reported as a lost mention (§6.4:
 *     "failed fetch is never 'no issue found'").
 *  3. **A found token is a mention, not an endorsement.** The copy says so
 *     where the evidence is, not in a footnote.
 *  4. **Removing is destructive and cascades.** The confirmation names the
 *     target and states that its check history goes with it.
 *
 * There is no "get one target" route, so the target is read out of the project's
 * target list by id. A miss is reported as a not-found rather than as an empty
 * page — the id may be from another project, and the screen does not claim to
 * know which.
 */

const FILTER_DEFAULTS = {
  /** The brand token the check searches for. Carried to AT04 from here. */
  brand: '',
};

export default function OutreachTargetPage() {
  const params = useParams<{ projectId: string; targetId: string }>();
  const projectId = params.projectId;
  const targetId = params.targetId;

  const router = useRouter();

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const [target, setTarget] = useState<MentionTargetWithLatestCheck | null>(null);
  const [checks, setChecks] = useState<MentionCheck[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState<MentionCheck | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const targets = await listMentionTargets(projectId, undefined, { signal });
        const found = targets.find((row) => row.id === targetId) ?? null;
        setTarget(found);
        if (found) {
          setLabel(found.label ?? '');
          setNotes(found.notes ?? '');
          setChecks(await listMentionChecks(projectId, targetId, { signal }));
        } else {
          setChecks([]);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoaded(true);
      }
    },
    [projectId, targetId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const brandToken = String(filters.brand ?? '').trim();
  const canCheck = brandToken.length >= 2;

  const latestMention = useMemo(
    () => (checks ?? []).find((check) => check.mentioned) ?? null,
    [checks],
  );

  async function runCheck() {
    setBusy(true);
    setActionError(null);
    try {
      await checkMentionTarget(projectId, targetId, brandToken);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails(patch: {
    label?: string;
    notes?: string;
    status?: MentionTargetStatus;
  }) {
    setBusy(true);
    setActionError(null);
    try {
      await updateMentionTarget(projectId, targetId, patch);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    setActionError(null);
    await deleteMentionTarget(projectId, targetId);
    setConfirmingRemove(false);
    // The target no longer exists, so this detail route has nothing to show;
    // the list it belongs to is the only sensible destination.
    router.push(`/projects/${projectId}/authority/campaigns`);
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Outreach target" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (!target) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Outreach target"
          breadcrumbs={[
            { label: 'Authority' },
            { label: 'Outreach campaigns', href: `/projects/${projectId}/authority/campaigns` },
          ]}
        />
        {/*
          The list this route reads from is scoped to this project, so a miss
          means the target is not on this project — which may be because it does
          not exist or because it belongs to another one. `missing-or-private`
          says exactly that much and no more.
        */}
        <ErrorState
          error={
            new ApiError({
              kind: 'not-found',
              status: 404,
              message: 'No target with this id is on this project.',
            })
          }
          notFoundReason="missing-or-private"
          onRetry={() => void load()}
        />
        <p className="text-meta text-muted-foreground">
          Target ids are only resolvable within the project they belong to. If this link was
          copied from another project, open it there instead.
        </p>
      </div>
    );
  }

  const checkColumns: ReadonlyArray<ColumnDef<MentionCheck>> = [
    {
      key: 'checkedAt',
      header: 'Checked',
      accessor: (row) => row.checkedAt,
      sortable: true,
      width: 200,
      render: (row) => <Timestamp value={row.checkedAt} />,
    },
    {
      key: 'finding',
      header: 'Finding',
      width: 210,
      render: (row) => <CheckFinding check={row} />,
    },
    {
      key: 'httpStatus',
      header: 'Page response',
      accessor: (row) => row.httpStatus,
      sortable: true,
      width: 150,
      emptyLabel: 'Fetch failed',
      render: (row) =>
        row.httpStatus === null ? null : (
          <span className="tabular-nums">HTTP {row.httpStatus}</span>
        ),
    },
    {
      key: 'fetchedTitle',
      header: 'Page title as fetched',
      accessor: (row) => row.fetchedTitle,
      width: 240,
      emptyLabel: 'Not recorded',
    },
    {
      key: 'evidence',
      header: 'Evidence',
      width: 300,
      render: (row) => (
        <Button variant="ghost" size="sm" onClick={() => setInspecting(row)}>
          {row.evidence ? 'Inspect excerpt' : 'Inspect record'}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={target.label ?? target.url}
        breadcrumbs={[
          { label: 'Authority' },
          { label: 'Outreach campaigns', href: `/projects/${projectId}/authority/campaigns` },
          { label: target.label ?? 'Target' },
        ]}
        context={target.url}
        status={<StatusPill label={MENTION_TARGET_STATUS_LABEL[target.status as MentionTargetStatus] ?? target.status} tone={outreachTone(target.status)} />}
        primaryAction={{
          label: busy ? 'Checking…' : 'Check for the brand',
          onClick: () => void runCheck(),
          disabled: !canCheck || busy,
          disabledReason: canCheck
            ? undefined
            : 'Enter the brand token to search for. A check is only meaningful for a token you state.',
        }}
        secondaryActions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingRemove(true)}
          >
            <Trash2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            Remove
          </Button>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* ── The check ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Check this target</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            A check fetches this one page and records whether the brand token appears on it,
            with a short excerpt around the match. A page containing the token is evidence of a
            mention — not proof of endorsement, and not evidence of referral traffic.
          </p>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="brand-token">
                Brand token <span className="text-danger-foreground">(required)</span>
              </Label>
              <Input
                id="brand-token"
                value={String(filters.brand ?? '')}
                onChange={(event) => setFilters({ brand: event.target.value })}
                placeholder="Wave3Co"
              />
              <p className="text-meta text-muted-foreground">
                The exact string to look for on the page. It is kept in this page&rsquo;s URL so the
                check can be repeated from a link, and it is carried to mention health.
              </p>
            </div>
            <Button onClick={() => void runCheck()} disabled={!canCheck || busy}>
              {busy ? 'Checking…' : 'Check now'}
            </Button>
          </div>
          {!canCheck ? (
            <p className="text-meta text-muted-foreground" id="brand-token-requirement">
              Enter a brand token of at least two characters to enable the check.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Latest mention ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Latest mention</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!target.latestCheck ? (
            <EmptyState
              variant="not-measured"
              subject="this target's mention state"
              prerequisite="Run a check with the brand token"
            >
              <p>
                No check has ever been run against this target, so nothing is known about whether
                the brand appears on it. This is not a target that was checked and found absent.
              </p>
            </EmptyState>
          ) : latestMention ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="Mention found" tone="success" />
                <ProvenanceBadge kind="measured" label="From a fetched page" />
              </div>
              <p className="text-table">
                The brand token was present when this page was fetched on{' '}
                <Timestamp value={latestMention.checkedAt} className="text-table" />.
              </p>
              {latestMention.evidence ? (
                <blockquote className="evidence rounded-md border border-border bg-surface-sunken p-3 text-table text-foreground">
                  {latestMention.evidence}
                </blockquote>
              ) : (
                <p className="text-meta text-muted-foreground">
                  The check recorded a mention but no excerpt.
                </p>
              )}
              <p className="text-meta text-muted-foreground">
                A token on the page shows the page names the brand. It does not establish that the
                mention recommends it, that a link is followed, or that anyone arrived from it.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill
                  label={
                    target.latestCheck.httpStatus === null
                      ? 'Page could not be fetched'
                      : 'Checked — brand not present'
                  }
                  tone={target.latestCheck.httpStatus === null ? 'warning' : 'neutral'}
                />
                <Timestamp value={target.latestCheck.checkedAt} />
              </div>
              <p className="text-table text-muted-foreground">
                {target.latestCheck.httpStatus === null
                  ? 'The most recent check could not fetch the page, so it produced no finding about whether the brand is mentioned. This is a failed check, not an absent mention.'
                  : 'The most recent check reached the page and did not find the brand token in it.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Details ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Target details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-4">
            <div className="col-span-2">
              <dt className="text-meta text-muted-foreground">URL</dt>
              <dd className="mt-0.5 break-all">{target.url}</dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Recorded</dt>
              <dd className="mt-0.5">
                <Timestamp value={target.createdAt} />
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Source</dt>
              <dd className="mt-0.5">
                <ProvenanceBadge kind="operator-supplied" />
              </dd>
            </div>
          </dl>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="target-status">Outreach status</Label>
              <Select
                value={target.status}
                onValueChange={(value) => void saveDetails({ status: value as MentionTargetStatus })}
              >
                <SelectTrigger id="target-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MENTION_TARGET_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {MENTION_TARGET_STATUS_LABEL[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                This records where the outreach stands. Advancing it here does not contact anyone.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-label-edit">Label</Label>
              <Input
                id="target-label-edit"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-notes-edit">Notes</Label>
            <Textarea
              id="target-notes-edit"
              rows={4}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Who to approach, what was said, what was agreed"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              disabled={
                busy ||
                (label === (target.label ?? '') && notes === (target.notes ?? ''))
              }
              onClick={() => void saveDetails({ label, notes })}
            >
              {busy ? 'Saving…' : 'Save details'}
            </Button>
            <span className="text-meta text-muted-foreground">
              Changing the status above saves immediately; these fields save together.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Check history ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Check history</CardTitle>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="pt-2">
          {!checks || checks.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="check history"
              prerequisite="Run a check with the brand token"
            />
          ) : (
            <>
              <DataTable
                caption="Mention check history"
                columns={checkColumns}
                rows={checks}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'checkedAt', direction: 'desc' }}
                emptyState={<EmptyState variant="no-results" />}
                minTableWidth="60rem"
              />
              <p className="mt-3 text-meta text-muted-foreground">
                The decay view treats a target as stale after {MENTION_DECAY_DAYS} days without a
                mention. A check that could not fetch the page neither refreshes nor ages a
                mention.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {inspecting ? (
        <EvidenceDrawer
          open
          onOpenChange={(open) => {
            if (!open) setInspecting(null);
          }}
          title="Mention check"
          source={{
            name: 'Single-page mention check',
            capturedAt: inspecting.checkedAt,
            url: target.url,
            query: brandToken || undefined,
          }}
          observed={
            inspecting.mentioned ? (
              <p>The brand token was present in the fetched page.</p>
            ) : inspecting.httpStatus === null ? (
              <p>
                The page could not be fetched, so this check produced no finding about the brand.
              </p>
            ) : (
              <p>
                The page was fetched (HTTP {inspecting.httpStatus}) and the brand token was not
                present in it.
              </p>
            )
          }
          raw={{
            label: 'Recorded check',
            text: [
              `checkedAt: ${inspecting.checkedAt}`,
              `mentioned: ${inspecting.mentioned}`,
              `httpStatus: ${inspecting.httpStatus ?? 'null (fetch failed)'}`,
              `fetchedTitle: ${inspecting.fetchedTitle ?? 'null'}`,
              `evidence: ${inspecting.evidence ?? 'null'}`,
            ].join('\n'),
          }}
          confidence={{
            level: 'unknown',
            basis:
              'A check records what one fetch of the page returned at one instant. There is no basis recorded for treating it as representative of other times or other visitors.',
          }}
          provenance="measured"
        />
      ) : null}

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove this target?"
        confirmLabel="Remove target"
        targetLabel="Target"
        target={target.label ?? target.url}
        destructive
        effect={
          <p>
            The target and its entire check history are deleted. Mentions already recorded for the
            brand elsewhere are unaffected, but nothing on this page can be recovered.
          </p>
        }
        scope={<p>Removing this target does not remove any promoted candidate or campaign.</p>}
        onConfirm={confirmRemove}
        onConfirmed={() => setConfirmingRemove(false)}
      />
    </div>
  );
}

/** The finding for one check, keeping the two "false" cases apart. */
function CheckFinding({ check }: { check: MentionCheck }) {
  if (check.httpStatus === null) {
    return (
      <div className="space-y-0.5">
        <StatusPill label="Check failed" tone="warning" />
        <div className="text-meta text-muted-foreground">The page could not be fetched.</div>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <StatusPill
        label={check.mentioned ? 'Mention found' : 'Not on the page'}
        tone={check.mentioned ? 'success' : 'neutral'}
      />
      {check.evidence ? (
        <div className="truncate text-meta text-muted-foreground">{check.evidence}</div>
      ) : null}
    </div>
  );
}

function outreachTone(status: string): StatusTone {
  switch (status) {
    case 'placed':
      return 'success';
    case 'replied':
      return 'info';
    case 'contacted':
      return 'info';
    default:
      return 'neutral';
  }
}
