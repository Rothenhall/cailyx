'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  History,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { GenerationDialog } from '@/components/content/GenerationDialog';
import { formatNumber } from '@/lib/format';
import { createApproval } from '@/services/approvals';
import {
  generationImplementedFor,
  getContentWorkspaceItem,
  listContentCapabilities,
  setContentAssignee,
  shareRevision,
  unshareRevision,
  type ContentCapability,
  type ContentWorkspaceDetail,
  type ContentWorkspaceRevisionSummary,
} from '@/services/content-workspace';
import {
  listAssetRevisions,
  saveAssetContent,
  versionConflictOf,
  type ContentRevision,
  type VersionConflict,
} from '@/services/content';
import { listTeamMembers, type TeamMember } from '@/services/delivery-plan';
import { createSleeperPage, listSleeperPages, type SleeperPage } from '@/services/refreshes';

/**
 * P08 — the staff content detail, to §13.5's anatomy:
 * **header / preview-editor / content plan / review / schedule / history.**
 *
 * The organising constraint is §13.4: there is no single "status" on this page.
 * The header shows the derived `primaryBadge` *and* all four axes, because the
 * badge is a summary and the axes are the facts — a piece that is
 * `published` with `updateState: revision-in-progress` must say both, or the
 * reader will conclude the live page is a draft.
 *
 * Two further rules are load-bearing here:
 *
 *  - **§13.5/§14.4 — sharing is per revision and explicit.** The Share control
 *    acts on one revision id and is the only thing on this page that changes
 *    what a client can see. Unshare is offered beside it, because a share that
 *    cannot be taken back is not consent.
 *  - **§13.9 — no fake Generate.** "Create another version" only exists when
 *    the capability matrix says a writer exists for this type. Otherwise the
 *    page offers the manual path and says why, rather than a button that would
 *    fail after the click.
 *
 * Editing is deliberately *not* reimplemented: the save path is the existing
 * revision endpoint (`PATCH .../assets/:id/content`), guarded by
 * `expectedVersion`, so a concurrent edit is a visible 409 rather than a silent
 * overwrite (§3.5).
 */

export default function ContentDetailPage() {
  const params = useParams<{ projectId: string; assetId: string }>();
  const { projectId, assetId } = params;

  const [detail, setDetail] = useState<ContentWorkspaceDetail | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [capabilities, setCapabilities] = useState<ContentCapability[] | undefined>(undefined);
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [teamRefused, setTeamRefused] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // §13.5 preview-editor: the current revision is the editable one; a history
  // row can be opened read-only so staff can confirm what was actually sent.
  const [draft, setDraft] = useState<{ title: string; body: string; fields: Record<string, unknown> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<VersionConflict | null>(null);
  const [historyBodies, setHistoryBodies] = useState<ContentRevision[] | null>(null);
  const [viewingRevisionId, setViewingRevisionId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshPages, setRefreshPages] = useState<SleeperPage[] | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        const result = await getContentWorkspaceItem(projectId, assetId, { signal });
        setDetail(result);
        setDraft(
          result.currentRevision
            ? {
                title: result.currentRevision.title ?? result.title,
                body: result.currentRevision.body ?? '',
                fields: result.currentRevision.fields ?? {},
              }
            : { title: result.title, body: '', fields: {} },
        );
        setViewingRevisionId(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      }
    },
    [projectId, assetId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void listContentCapabilities(projectId, { signal: controller.signal })
      .then(setCapabilities)
      .catch(() => setCapabilities([]));
    void listTeamMembers({ signal: controller.signal })
      .then((members) => {
        setTeam(members);
        setTeamRefused(false);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setTeamRefused(true);
      });
    return () => controller.abort();
  }, [load, projectId]);

  // §13.11 — the refresh mechanism is read, not reimplemented: this only asks
  // whether this piece's live URL is already tracked for refresh.
  const liveUrl = detail?.publicationSummary.placements.find((p) => p.remoteUrl)?.remoteUrl ?? null;
  useEffect(() => {
    if (!liveUrl) return;
    const controller = new AbortController();
    void listSleeperPages(projectId, {}, { signal: controller.signal })
      .then(setRefreshPages)
      .catch(() => setRefreshPages([]));
    return () => controller.abort();
  }, [projectId, liveUrl]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>, notice?: string) => {
      setBusy(key);
      setActionError(null);
      setActionNotice(null);
      try {
        await action();
        if (notice) setActionNotice(notice);
        await load();
      } catch (caught) {
        setActionError(
          caught instanceof Error ? caught.message : 'That action could not be completed.',
        );
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const save = useCallback(async () => {
    if (!detail || !draft) return;
    setSaving(true);
    setSaveError(null);
    setConflict(null);
    try {
      await saveAssetContent(projectId, assetId, {
        title: draft.title,
        body: draft.body,
        fields: draft.fields,
        // The version this edit was based on. A newer revision makes this a
        // 409 — the save is refused and the server's state is shown, never
        // overwritten.
        expectedVersion: detail.currentVersion,
      });
      await load();
      setActionNotice('Saved as a new revision. The previous revision is unchanged.');
    } catch (caught) {
      const asConflict = versionConflictOf(caught);
      if (asConflict) setConflict(asConflict);
      else setSaveError(caught instanceof Error ? caught.message : 'The save failed.');
    } finally {
      setSaving(false);
    }
  }, [detail, draft, projectId, assetId, load]);

  const previewRevision = useCallback(
    async (revisionId: string) => {
      setBusy(`preview-${revisionId}`);
      try {
        if (!historyBodies) {
          const result = await listAssetRevisions(projectId, assetId);
          setHistoryBodies(result.revisions);
        }
        setViewingRevisionId(revisionId);
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : 'That revision could not be read.');
      } finally {
        setBusy(null);
      }
    },
    [historyBodies, projectId, assetId],
  );

  const viewedRevision = useMemo(
    () => (viewingRevisionId ? historyBodies?.find((r) => r.id === viewingRevisionId) ?? null : null),
    [viewingRevisionId, historyBodies],
  );

  const capabilityRow = capabilities?.find((entry) => entry.assetType === detail?.assetType);
  const generationImplemented = generationImplementedFor(capabilities, detail?.assetType ?? '');
  const trackedRefresh = useMemo(
    () => (liveUrl ? (refreshPages ?? []).find((page) => page.url === liveUrl) ?? null : null),
    [liveUrl, refreshPages],
  );

  const pendingApproval = useMemo(() => {
    if (!detail) return null;
    return (
      detail.approvals.find(
        (approval) =>
          approval.status === 'pending' &&
          approval.reviewerType === 'client' &&
          approval.artifactRevision === detail.currentVersion,
      ) ?? null
    );
  }, [detail]);

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" breadcrumbs={[{ label: 'Content', href: `/projects/${projectId}/content` }]} />
        <ErrorState error={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" breadcrumbs={[{ label: 'Content', href: `/projects/${projectId}/content` }]} />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const currentRevision = detail.currentRevision;
  const sharedCount = detail.revisions.filter((revision) => revision.clientVisible).length;

  return (
    <div className="space-y-6">
      {/* ── §13.5 header ─────────────────────────────────────────────── */}
      <PageHeader
        breadcrumbs={[
          { label: 'Content', href: `/projects/${projectId}/content` },
          { label: detail.title },
        ]}
        title={detail.title}
        context={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{capabilityRow?.label ?? detail.assetType}</span>
            {detail.market ? <span>{detail.market}</span> : null}
            {detail.language ? <span>{detail.language}</span> : null}
            {detail.sourceOpportunityId ? (
              <Link
                href={`/projects/${projectId}/content/opportunities`}
                className="text-primary underline-offset-4 hover:underline"
              >
                From an idea
              </Link>
            ) : null}
          </span>
        }
        status={<AxisStrip detail={detail} />}
        primaryAction={
          generationImplemented === true
            ? {
                label: 'Create another version',
                icon: <Sparkles />,
                onClick: () => setDialogOpen(true),
                disabledReason: undefined,
              }
            : {
                label: 'Create another version',
                disabled: true,
                disabledReason:
                  generationImplemented === false
                    ? `No tested writer exists for ${capabilityRow?.label ?? detail.assetType}. A new revision is still available by editing below — that records your text as revision ${detail.currentVersion + 1}.`
                    : 'Checking whether a writer exists for this type.',
              }
        }
        secondaryActions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content/writing-style`}>Writing style</Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={busy === 'reload'}
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Reload
            </Button>
          </div>
        }
      />

      {actionError ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>That action did not complete</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {actionNotice ? (
        <Alert>
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{actionNotice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* ── §13.5 preview-editor ─────────────────────────────────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-subsection">Preview and editor</CardTitle>
              <div className="flex items-center gap-2">
                {viewingRevisionId ? (
                  <Button variant="ghost" size="sm" onClick={() => setViewingRevisionId(null)}>
                    Back to the current revision
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={saving || viewingRevisionId !== null}
                >
                  {saving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save as revision {detail.currentVersion + 1}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {viewingRevisionId ? (
                <div className="space-y-3">
                  <p className="text-meta text-muted-foreground">
                    Revision {viewedRevision?.revision ?? '—'} — read-only, as saved. Editing always
                    happens on the current revision.
                  </p>
                  <h3 className="text-subsection font-medium">{viewedRevision?.title ?? 'Untitled'}</h3>
                  <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-sunken p-3 text-table">
                    {viewedRevision?.body ?? 'This revision has no stored body.'}
                  </pre>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="revision-title">Title</Label>
                    <Input
                      id="revision-title"
                      value={draft?.title ?? ''}
                      onChange={(event) =>
                        setDraft((current) => (current ? { ...current, title: event.target.value } : current))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="revision-body">Body</Label>
                    <Textarea
                      id="revision-body"
                      rows={18}
                      className="font-mono text-table"
                      value={draft?.body ?? ''}
                      onChange={(event) =>
                        setDraft((current) => (current ? { ...current, body: event.target.value } : current))
                      }
                    />
                    <p className="text-meta text-muted-foreground">
                      {formatNumber((draft?.body ?? '').trim().split(/\s+/).filter(Boolean).length)} words ·
                      current revision {detail.currentVersion}
                      {currentRevision ? ` · ${currentRevision.origin.replace('-', ' ')}` : ''}
                      {currentRevision ? (
                        <>
                          {' · '}
                          <Timestamp value={currentRevision.createdAt} />
                        </>
                      ) : null}
                    </p>
                  </div>

                  {conflict ? (
                    <Alert variant="destructive">
                      <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                      <AlertTitle>Someone saved a newer revision while you were editing</AlertTitle>
                      <AlertDescription className="space-y-2">
                        <p>
                          The server is at revision {conflict.currentVersion}; your editor is based on
                          revision {detail.currentVersion}. Nothing was overwritten.
                        </p>
                        <Button variant="outline" size="sm" onClick={() => void load()}>
                          Load the server&apos;s revision and discard my unsaved text
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {saveError ? <p className="text-table text-warning-foreground">{saveError}</p> : null}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── §13.5 content plan ───────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Content plan</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.brief ? (
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Field label="Plan" value={`${detail.brief.title} · v${detail.brief.version}`} />
                  <Field label="Approval" value={detail.brief.status} />
                  <Field label="Audience" value={detail.brief.audience} />
                  <Field label="Intent" value={detail.brief.intent} />
                  <Field label="Angle" value={detail.brief.angle} />
                  <Field
                    label="Length target"
                    value={detail.brief.wordTarget ? `${formatNumber(detail.brief.wordTarget)} words` : null}
                  />
                  <Field
                    label="Must include"
                    value={detail.brief.mustInclude.length > 0 ? detail.brief.mustInclude.join(' · ') : null}
                    wide
                  />
                  <Field
                    label="Source references"
                    value={
                      detail.brief.references.length > 0
                        ? detail.brief.references.map((reference) => reference.note || reference.url).join(' · ')
                        : null
                    }
                    wide
                  />
                </dl>
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="a content plan"
                  prerequisite="attach an approved plan before generating, or promote an idea"
                  action={{ label: 'Open content opportunities', href: `/projects/${projectId}/content/opportunities` }}
                >
                  This piece has no instruction set. Generation is refused without an approved plan
                  rather than writing from a topic alone.
                </EmptyState>
              )}
            </CardContent>
          </Card>

          {/* ── §13.5 schedule ───────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Schedule and placements</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {detail.publications.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  No destination is scheduled for this piece. A placement is what publishes a
                  revision — until one exists, this content is not live anywhere.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {detail.publications.map((placement) => (
                    <li
                      key={placement.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-table text-foreground">
                          {placement.provider || 'Destination'} · {placement.mode}
                        </p>
                        <p className="text-meta text-muted-foreground">
                          {placement.scheduledFor ? (
                            <>
                              <CalendarDays aria-hidden="true" className="mr-1 inline h-3 w-3" />
                              <Timestamp value={placement.scheduledFor} dateOnly />
                            </>
                          ) : (
                            'No date set'
                          )}
                          {placement.revisionNumber !== null
                            ? ` · publishes revision ${placement.revisionNumber}`
                            : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill label={placement.status} tone={placementTone(placement.status)} />
                        {placement.remoteUrl ? (
                          <a
                            href={placement.remoteUrl}
                            className="inline-flex items-center gap-1 text-table text-primary underline-offset-4 hover:underline"
                          >
                            Live page
                            <ExternalLink aria-hidden="true" className="h-3 w-3" />
                          </a>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* §13.11 — the refresh mechanism, reused rather than rebuilt. */}
              <div className="rounded-lg border border-border bg-surface-sunken p-3">
                <p className="text-table font-medium text-foreground">Update this page</p>
                {!liveUrl ? (
                  <p className="mt-1 text-meta text-muted-foreground">
                    This piece has no live URL yet, so there is nothing to update. A refresh is
                    tracked against the page that is actually published.
                  </p>
                ) : trackedRefresh ? (
                  <p className="mt-1 text-meta text-muted-foreground">
                    {trackedRefresh.url} is already tracked as{' '}
                    <StatusPill label={trackedRefresh.status.replace(/-/g, ' ')} tone="neutral" />.{' '}
                    <Link
                      href={`/projects/${projectId}/content/refreshes`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      Open the refreshes screen
                    </Link>{' '}
                    to record the new date, or to mark it shipped.
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-meta text-muted-foreground">
                      Tracking a refresh adds {liveUrl} to the refresh queue, where it is scheduled,
                      approved and monitored. It does not rewrite this piece.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={busy === 'refresh'}
                      onClick={() =>
                        void runAction(
                          'refresh',
                          () =>
                            createSleeperPage(projectId, {
                              url: liveUrl,
                              label: detail.title,
                              notes: `Proposed from the content workspace (revision ${detail.currentVersion}).`,
                            }),
                          'The refresh is now tracked. Its schedule and result live on the refreshes screen.',
                        )
                      }
                    >
                      <History aria-hidden="true" className="mr-2 h-4 w-4" />
                      {busy === 'refresh' ? 'Adding…' : 'Track a refresh for this page'}
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {/* ── owner ────────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Owner</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {teamRefused ? (
                <p className="text-meta text-muted-foreground">
                  The staff directory is not visible to your role, so ownership cannot be changed
                  here. It is not the same as nobody owning this piece.
                </p>
              ) : (
                <Select
                  value={detail.assigneeId ?? 'unassigned'}
                  onValueChange={(next) =>
                    void runAction('assign', () =>
                      setContentAssignee(projectId, assetId, next === 'unassigned' ? null : next),
                    )
                  }
                  disabled={busy === 'assign'}
                >
                  <SelectTrigger aria-label="Owner">
                    <SelectValue>
                      {team?.find((member) => member.id === detail.assigneeId)?.name ?? 'Unassigned'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {(team ?? []).map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </CardContent>
          </Card>

          {/* ── §13.5 review ─────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-table">
                <p className="text-muted-foreground">
                  Client review: <strong>{CLIENT_LABEL[detail.clientReviewState]}</strong>
                </p>
                <p className="text-muted-foreground">
                  Shared revisions: {sharedCount} of {detail.revisions.length}
                </p>
              </div>

              {detail.approvals.length === 0 ? (
                <p className="text-meta text-muted-foreground">
                  No review has been requested yet. A request is pinned to one revision, so
                  approving it can never approve a later draft by accident.
                </p>
              ) : (
                <ul className="space-y-2">
                  {detail.approvals.map((approval) => (
                    <li key={approval.id} className="rounded-lg border border-border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-table text-foreground">
                          {approval.reviewerType === 'client' ? 'Client' : 'Internal'} review
                          {approval.artifactRevision !== null ? ` · rev ${approval.artifactRevision}` : ''}
                        </span>
                        <StatusPill label={approval.status.replace('-', ' ')} tone={approvalTone(approval.status)} />
                      </div>
                      <p className="mt-1 text-meta text-muted-foreground">
                        Requested <Timestamp value={approval.createdAt} />
                        {approval.dueAt ? (
                          <>
                            {' · due '}
                            <Timestamp value={approval.dueAt} dateOnly />
                          </>
                        ) : null}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {pendingApproval ? (
                <p className="text-meta text-muted-foreground">
                  A client review of revision {pendingApproval.artifactRevision} is open.{' '}
                  <Link
                    href={`/projects/${projectId}/content/reviews`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Open reviews
                  </Link>
                </p>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === 'request-review' || !currentRevision?.clientVisible}
                  title={
                    currentRevision?.clientVisible
                      ? undefined
                      : 'The current revision is not shared. Asking a client to review a revision they cannot read would be a broken promise.'
                  }
                  onClick={() =>
                    void runAction(
                      'request-review',
                      () =>
                        createApproval(projectId, {
                          artifactType: 'content',
                          artifactId: assetId,
                          artifactRevision: detail.currentVersion,
                          revisionId: currentRevision?.id,
                          title: `${detail.title} — revision ${detail.currentVersion}`,
                          reviewerType: 'client',
                        }),
                      'Client review requested for this exact revision.',
                    )
                  }
                >
                  <ShieldCheck aria-hidden="true" className="mr-2 h-4 w-4" />
                  Request a client review of revision {detail.currentVersion}
                </Button>
              )}

              {detail.checks.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-meta text-muted-foreground">Checks</p>
                  <ul className="space-y-1">
                    {detail.checks.map((check) => (
                      <li key={check.id} className="flex items-start justify-between gap-2 text-table">
                        <span className="text-muted-foreground">
                          {check.checkKind}
                          {check.detail ? ` — ${check.detail}` : ''}
                        </span>
                        <StatusPill label={check.status} tone={checkTone(check.status)} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* ── §13.5 history ────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">History</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {detail.revisions.length === 0 ? (
                <p className="text-meta text-muted-foreground">
                  Nothing has been saved yet, so there is no revision history to show.
                </p>
              ) : (
                <ul className="space-y-2">
                  {detail.revisions.map((revision) => (
                    <RevisionRow
                      key={revision.id}
                      revision={revision}
                      isCurrent={revision.id === currentRevision?.id}
                      busy={busy}
                      onPreview={() => void previewRevision(revision.id)}
                      onShare={() =>
                        void runAction(
                          `share-${revision.id}`,
                          () => shareRevision(projectId, assetId, revision.id),
                          `Revision ${revision.revision} is now visible to the client.`,
                        )
                      }
                      onUnshare={() =>
                        void runAction(
                          `unshare-${revision.id}`,
                          () => unshareRevision(projectId, assetId, revision.id),
                          `Revision ${revision.revision} is no longer visible to the client.`,
                        )
                      }
                    />
                  ))}
                </ul>
              )}
              <p className="text-meta text-muted-foreground">
                Sharing is per revision and never inherited: a new revision starts private, so a
                client keeps seeing the last revision you shared until you share a newer one.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <GenerationDialog
        projectId={projectId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={{
          kind: 'version',
          assetId,
          assetTitle: detail.title,
          assetType: detail.assetType,
          topic: detail.brief?.title ?? detail.title,
        }}
        capabilities={capabilities}
        onAccepted={() => void load()}
      />
    </div>
  );
}

/** §13.4 — the four axes, always rendered together, under the derived badge. */
function AxisStrip({ detail }: { detail: ContentWorkspaceDetail }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusPill label={detail.primaryBadge} tone={badgeTone(detail)} />
      <span className="text-meta text-muted-foreground">
        Editorial: <strong className="font-medium text-foreground">{EDITORIAL_LABEL[detail.editorialState]}</strong>
      </span>
      <span className="text-meta text-muted-foreground">
        Client: <strong className="font-medium text-foreground">{CLIENT_LABEL[detail.clientReviewState]}</strong>
      </span>
      <span className="text-meta text-muted-foreground">
        Publication:{' '}
        <strong className="font-medium text-foreground">{PUBLICATION_LABEL[detail.publicationSummary.status]}</strong>
      </span>
      <span className="text-meta text-muted-foreground">
        Update: <strong className="font-medium text-foreground">{UPDATE_LABEL[detail.updateState]}</strong>
      </span>
    </span>
  );
}

function RevisionRow({
  revision,
  isCurrent,
  busy,
  onPreview,
  onShare,
  onUnshare,
}: {
  revision: ContentWorkspaceRevisionSummary;
  isCurrent: boolean;
  busy: string | null;
  onPreview: () => void;
  onShare: () => void;
  onUnshare: () => void;
}) {
  return (
    <li className="rounded-lg border border-border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-table text-foreground">
            Revision {revision.revision}
            {isCurrent ? ' · current' : ''}
          </p>
          <p className="text-meta text-muted-foreground">
            {revision.origin.replace('-', ' ')} · {formatNumber(revision.wordCount)} words ·{' '}
            <Timestamp value={revision.createdAt} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill
            label={revision.clientVisible ? 'Shared with client' : 'Internal only'}
            tone={revision.clientVisible ? 'success' : 'neutral'}
          />
          <Button variant="ghost" size="sm" onClick={onPreview} disabled={busy === `preview-${revision.id}`}>
            <Eye aria-hidden="true" className="mr-1 h-3 w-3" />
            Preview
          </Button>
          {revision.clientVisible ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onUnshare}
              disabled={busy === `unshare-${revision.id}`}
            >
              <EyeOff aria-hidden="true" className="mr-1 h-3 w-3" />
              Unshare
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onShare}
              disabled={busy === `share-${revision.id}`}
            >
              <Plus aria-hidden="true" className="mr-1 h-3 w-3" />
              Share with client
            </Button>
          )}
        </div>
      </div>
      {revision.clientVisible && revision.clientVisibleAt ? (
        <p className="mt-1 text-meta text-muted-foreground">
          Shared <Timestamp value={revision.clientVisibleAt} />
        </p>
      ) : null}
    </li>
  );
}

function Field({ label, value, wide }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="text-table text-foreground">{value ?? 'Not recorded'}</dd>
    </div>
  );
}

const EDITORIAL_LABEL: Record<string, string> = {
  planned: 'Planned',
  drafting: 'Drafting',
  draft: 'Draft',
  'internal-review': 'Internal review',
  'changes-requested': 'Changes requested',
  'ready-for-client': 'Ready for client',
  approved: 'Approved',
};

const CLIENT_LABEL: Record<string, string> = {
  'not-shared': 'Not shared',
  'awaiting-review': 'Awaiting client review',
  'changes-requested': 'Client requested changes',
  approved: 'Client approved',
  'expired-superseded': 'Superseded',
};

const PUBLICATION_LABEL: Record<string, string> = {
  unscheduled: 'Not scheduled',
  planned: 'Planned placement',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Publish failed',
};

const UPDATE_LABEL: Record<string, string> = {
  'no-update': 'No update in progress',
  'revision-in-progress': 'Update in progress',
};

function badgeTone(detail: ContentWorkspaceDetail): StatusTone {
  if (detail.publicationSummary.status === 'published') return 'success';
  if (detail.publicationSummary.status === 'failed') return 'danger';
  if (detail.publicationSummary.status === 'scheduled') return 'info';
  if (detail.clientReviewState === 'changes-requested') return 'warning';
  if (detail.editorialState === 'approved' || detail.clientReviewState === 'approved') return 'success';
  if (detail.editorialState === 'planned') return 'neutral';
  return 'unmeasured';
}

function placementTone(status: string): StatusTone {
  if (status === 'published') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'publishing') return 'info';
  return 'neutral';
}

function approvalTone(status: string): StatusTone {
  if (status === 'approved') return 'success';
  if (status === 'changes-requested') return 'warning';
  if (status === 'pending') return 'info';
  return 'neutral';
}

function checkTone(status: string): StatusTone {
  if (status === 'passed' || status === 'ok') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'warning') return 'warning';
  return 'neutral';
}
