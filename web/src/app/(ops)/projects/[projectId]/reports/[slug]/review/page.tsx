'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  Info,
  Link2,
  Lock,
  Send,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ApprovalCard } from '@/components/patterns/ApprovalCard';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { ApiError } from '@/lib/api';
import { reportStatusLabel, reportStatusTone } from '@/lib/status-tones';
import type { ApprovalItem } from '@/types';
import {
  coverageFromManifest,
  createReportShareLink,
  decideReportRevision,
  findReportRow,
  getReport,
  getReportLifecycle,
  getReportRevision,
  listEvidenceManifests,
  listReportShareLinks,
  publishReport,
  reportRenderUrl,
  reviewReport,
  revokeReportShareLink,
  setReportVisibility,
  shareLinkAbsoluteUrl,
  withdrawReport,
  type EvidenceManifestView,
  type ReportData,
  type ReportLibraryRow,
  type ReportLifecycle,
  type ReportPublishBlock,
  type ReportRevisionDetail,
  type ReportRevisionRow,
  type ReportShareLink,
  type ReportShareLinkCreated,
  type ReportSubScore,
} from '@/services/reports';

/**
 * RP04 — Report review & release.
 *
 * design_plan.md §4.4: *"Checklist, internal approval, client publication,
 * public-share controls"*, in the Approvals layout family (§4): decision
 * summary, exact artifact/version preview, sticky actions, read-only after a
 * recorded decision.
 *
 * **The single most important thing on this screen is that there are two
 * axes, not one.** §6.4, §8.3 and the reporting module README all say the
 * same thing: the editorial lifecycle (draft → in review → approved →
 * released → withdrawn) and the public "anyone with the link" URL are
 * independent, share no code path, and are changed by different endpoints.
 * They are rendered here as two cards with separate consequences, and
 * `visibility` is never presented as an approval or a release.
 *
 * Four rules from the shipped G05 API are structural here, not copy:
 *
 *  1. **Only valid next steps are offered.** `GET :slug/lifecycle` returns the
 *     summary `status`, the `inFlightRevision` and `publishBlocked`, so this
 *     screen knows which transition the server would accept. `review`,
 *     `approve` and `publish` each 409 for the other states, and no control
 *     that would 409 is rendered — the state is read, not guessed.
 *  2. **A refused release is disclosed before the button, not after.** The
 *     G10 gate re-runs inside `publish`; `publishBlocked` is a read-only
 *     disclosure of the same verdict, so the release control is disabled with
 *     the gate's own reason rather than letting the operator discover it from
 *     a failed request.
 *  3. **The released revision is frozen and stays frozen.** Once released, its
 *     number is shown prominently with what it means: later revisions are
 *     separate documents, a superseded one keeps its frozen bytes, and the
 *     client keeps reading the released version until a newer one is released
 *     (§11.2 case 12).
 *  4. **A share token is shown exactly once.** The server stores only its
 *     sha256, so the created link is rendered in a one-time block with the
 *     same discipline OP08 uses for a temporary password.
 *
 * The checklist is evaluated against the **frozen snapshot of the revision
 * under review** when one exists, not against the live row: an approval binds
 * to a version, and a report regenerated after review is a different document.
 */

/** The facts the checklist reads, from a revision snapshot or from the live row. */
interface ChecklistFacts {
  executiveSummary: string;
  scoreTotal: number;
  scoreBand: string;
  subScores: ReportSubScore[];
  growthPlan: unknown;
  backlinks: unknown;
  presence: unknown;
  competitors: unknown;
  rubricVersion: number | null;
  scoreRunId: string | null;
  manifestId: string | null;
}

/**
 * The transition the server would currently accept.
 *
 * A discriminated union rather than a set of booleans, so the render cannot
 * offer two mutually exclusive next steps and cannot offer one the API refuses.
 */
type NextStep =
  | { kind: 'review'; label: string; detail: string }
  | { kind: 'decide'; revision: ReportRevisionRow }
  | { kind: 'publish'; revision: ReportRevisionRow; blocked: ReportPublishBlock | null }
  | { kind: 'unavailable'; reason: string };

function revisionStatusLabel(status: string): string {
  return status === 'superseded' ? 'Superseded' : reportStatusLabel(status);
}

function revisionStatusTone(status: string): StatusTone {
  // `superseded` is not a `Report.status` value and is not a problem: it is a
  // version that a newer release replaced, which is the normal end state.
  return status === 'superseded' ? 'neutral' : reportStatusTone(status);
}

function decisionLabel(decision: string | null): string {
  switch (decision) {
    case 'approved':
      return 'Approved';
    case 'changes-requested':
      return 'Changes requested';
    case 'grandfathered':
      return 'Grandfathered — no internal review took place';
    default:
      return 'Not decided';
  }
}

export default function ReportReviewPage() {
  const params = useParams<{ projectId: string; slug: string }>();
  const { projectId, slug } = params;

  const [report, setReport] = useState<ReportData | null>(null);
  const [lifecycle, setLifecycle] = useState<ReportLifecycle | null>(null);
  const [manifest, setManifest] = useState<EvidenceManifestView | null>(null);
  /** The frozen snapshot of the revision in flight, when there is one. */
  const [revisionDetail, setRevisionDetail] = useState<ReportRevisionDetail | null>(null);
  const [links, setLinks] = useState<ReportShareLink[] | null>(null);
  const [row, setRow] = useState<ReportLibraryRow | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const [origin, setOrigin] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  /** The raw token from a minted link. Held in memory only, and only until the page is left. */
  const [createdLink, setCreatedLink] = useState<ReportShareLinkCreated | null>(null);
  const [copied, setCopied] = useState(false);

  // Form state, each owned by exactly one dialog.
  const [reviewNote, setReviewNote] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [releaseNote, setReleaseNote] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('');
  const [createLinkError, setCreateLinkError] = useState<ApiError | null>(null);
  const [creatingLink, setCreatingLink] = useState(false);

  // Dialog control.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ReportShareLink | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        // Both required reads: the content and the two axes. A screen that
        // rendered one without the other would be guessing at the state it is
        // about to change.
        const [data, life] = await Promise.all([
          getReport(projectId, slug, { signal }),
          getReportLifecycle(projectId, slug, { signal }),
        ]);
        setReport(data);
        setLifecycle(life);

        // Best-effort context. None of it decides a control, so a failure here
        // degrades the page rather than blocking it.
        try {
          const manifests = await listEvidenceManifests(
            projectId,
            { subjectType: 'report', subjectId: data.id, limit: 1 },
            { signal },
          );
          setManifest(manifests[0] ?? null);
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setManifest(null);
        }

        try {
          setLinks(await listReportShareLinks(projectId, slug, { signal }));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setLinks(null);
        }

        try {
          setRow(await findReportRow(projectId, slug, { signal }));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setRow(null);
        }

        // The revision under review, with its frozen snapshot. This is what an
        // approval binds to, so it is what the checklist must read.
        if (life.inFlightRevision) {
          try {
            setRevisionDetail(
              await getReportRevision(projectId, slug, life.inFlightRevision.revision, { signal }),
            );
          } catch (caught) {
            if (caught instanceof DOMException && caught.name === 'AbortError') return;
            setRevisionDetail(null);
          }
        } else {
          setRevisionDetail(null);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, slug],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const coverage = useMemo(() => coverageFromManifest(manifest), [manifest]);

  const releasedRevision = lifecycle?.releasedRevision ?? null;
  const inFlight = lifecycle?.inFlightRevision ?? null;
  const isReleased = lifecycle?.status === 'released' && releasedRevision !== null;

  /**
   * The one transition the server would accept right now.
   *
   * Read from the lifecycle rather than inferred from the summary status: the
   * summary is deliberately sticky once released, so `status === 'released'`
   * with a revision in flight means "the client is reading revision N while
   * revision N+1 is being prepared" — not "nothing is in flight".
   */
  const nextStep = useMemo<NextStep | null>(() => {
    if (!lifecycle) return null;
    const newestNumber = lifecycle.revisions[0]?.revision ?? 0;

    if (inFlight?.status === 'in-review') return { kind: 'decide', revision: inFlight };

    if (inFlight?.status === 'approved') {
      return { kind: 'publish', revision: inFlight, blocked: lifecycle.publishBlocked };
    }

    if (inFlight?.status === 'draft') {
      return {
        kind: 'review',
        label: `Lock revision ${inFlight.revision} for review again`,
        detail:
          'Changes were requested on this revision. Locking it again re-freezes the snapshot from the report’s current content — the same revision number, because nothing was ever approved or released from it.',
      };
    }

    if (inFlight) {
      // Defensive: a revision state this screen does not know about. Named
      // rather than guessed at, and no control is offered for it.
      return {
        kind: 'unavailable',
        reason: `Revision ${inFlight.revision} is "${inFlight.status}", which is not a state this screen knows how to advance. Nothing here should be used to move it.`,
      };
    }

    if (lifecycle.status === 'approved') {
      // The summary says approved but no revision is in flight, which the
      // state machine should make impossible. Guessing would risk a 409.
      return {
        kind: 'unavailable',
        reason:
          'The report is recorded as approved but no revision is in flight. Reload to reconcile this before taking any action.',
      };
    }

    return {
      kind: 'review',
      label:
        newestNumber === 0
          ? 'Lock revision 1 for review'
          : `Prepare revision ${newestNumber + 1} for review`,
      detail:
        newestNumber === 0
          ? 'Freezes the report’s current content as revision 1. The client sees nothing until that revision is approved and released.'
          : 'Opens a new revision from the report’s current content. The released revision keeps its frozen snapshot and stays live for the client until this one is released.',
    };
  }, [lifecycle, inFlight]);

  /** The checklist's source facts, and what they came from. */
  const facts = useMemo<{ data: ChecklistFacts; source: string } | null>(() => {
    if (revisionDetail) {
      const s = revisionDetail.snapshot;
      return {
        source: `revision ${revisionDetail.revision}’s frozen snapshot`,
        data: {
          executiveSummary: s.executiveSummary ?? '',
          scoreTotal: s.scoreTotal,
          scoreBand: s.scoreBand,
          subScores: s.subScores ?? [],
          growthPlan: s.growthPlan,
          backlinks: s.backlinks,
          presence: s.presence,
          competitors: s.competitors,
          rubricVersion: s.rubricVersion ?? null,
          scoreRunId: s.scoreRunId ?? null,
          manifestId: s.manifestId ?? null,
        },
      };
    }
    if (report) {
      return {
        source: 'the live report row — no revision is locked, so this is what a review would freeze',
        data: {
          executiveSummary: report.executiveSummary ?? '',
          scoreTotal: report.scoreTotal,
          scoreBand: report.scoreBand,
          subScores: report.subScores ?? [],
          growthPlan: report.growthPlan,
          backlinks: report.backlinks,
          presence: report.presence,
          competitors: report.competitors,
          rubricVersion: report.rubricVersion ?? null,
          scoreRunId: report.scoreRunId ?? null,
          manifestId: report.manifestId ?? null,
        },
      };
    }
    return null;
  }, [revisionDetail, report]);

  /**
   * The review checklist, evaluated from stored facts.
   *
   * Nothing here is a policy that could be satisfied by ticking a box: every
   * line re-reads the artifact and states what it found. That is deliberate —
   * a checklist whose items can be marked done without evidence is a checklist
   * that says "reviewed" when nothing was.
   */
  const checklist = useMemo(() => {
    if (!facts) return [];
    const source = facts.data;
    const includedSections = [
      source.growthPlan ? 'growth roadmap' : null,
      source.backlinks ? 'backlinks' : null,
      source.presence ? 'digital presence' : null,
      source.competitors ? 'competitors' : null,
    ].filter((name): name is string => name !== null);

    const items: Array<{ label: string; ok: boolean | null; detail: string }> = [
      {
        label: 'Executive summary written',
        ok: (source.executiveSummary ?? '').trim().length > 0,
        detail: (source.executiveSummary ?? '').trim().length
          ? `${(source.executiveSummary ?? '').trim().length} characters. Machine-written from the snapshot — read it before anyone else does.`
          : 'Empty. The report opens with no conclusion.',
      },
      {
        label: 'Rubric score recorded',
        ok: Number.isFinite(source.scoreTotal),
        detail: `Score ${source.scoreTotal} (${source.scoreBand}).`,
      },
      {
        label: 'Score provenance recorded',
        // Neither a pass nor a fail: an unrecorded run id is a fact about what
        // the manifest pinned, and §6.4 forbids filling it in from "the latest
        // run" — that would be a guess about provenance.
        ok: null,
        detail:
          source.rubricVersion !== null
            ? `Rubric version ${source.rubricVersion}${
                source.scoreRunId ? `, score run ${source.scoreRunId}` : ' (no score run id recorded)'
              }.`
            : 'No rubric version is recorded for this snapshot — the report predates the provenance linkage or its evidence manifest was not pinned. Reload the dependency rather than inferring it.',
      },
      {
        label: 'Every rubric dimension measured',
        ok:
          source.subScores.length > 0 &&
          source.subScores.every((entry) => typeof entry.score === 'number'),
        detail:
          source.subScores.length === 0
            ? 'No sub-scores are recorded on this snapshot, so the total cannot be broken down.'
            : source.subScores.some((entry) => typeof entry.score !== 'number')
              ? 'At least one dimension is unmeasured. Under the rubric it contributes zero — it is not silently reweighted, and the report should say so.'
              : `${source.subScores.length} dimension(s), all measured.`,
      },
      {
        label: 'Evidence coverage pinned and complete',
        ok: coverage ? coverage.failed.length === 0 : null,
        detail: coverage
          ? coverage.failed.length === 0
            ? `${coverage.successfulCount} of ${coverage.expectedCount} agreed evidence units succeeded${
                coverage.deferred.length ? `, ${coverage.deferred.length} deferred` : ''
              }.`
            : `${coverage.failed.length} source(s) failed. A failed fetch is not "no issue found" and must not be read as one.`
          : 'No evidence manifest is pinned for this report, so which sources it came from is unrecorded. That is not the same as complete.',
      },
      {
        label: 'Snapshot sections present',
        // Neither a pass nor a fail: an absent optional section is a fact
        // about what existed at generation time, not a defect to fix here.
        ok: null,
        detail:
          includedSections.length === 4
            ? 'All four optional sections are part of this snapshot.'
            : `Included: ${includedSections.join(', ') || 'none'}. Absent sections are stated as absent in the report itself, naming the run that would have produced them.`,
      },
    ];
    return items;
  }, [facts, coverage]);

  const revisionColumns = useMemo<ColumnDef<ReportRevisionRow>[]>(() => {
    const numberById = new Map((lifecycle?.revisions ?? []).map((r) => [r.id, r.revision]));
    return [
      {
        key: 'revision',
        header: 'Revision',
        accessor: (r) => r.revision,
        sortable: true,
        render: (r) => <span className="font-medium">Revision {r.revision}</span>,
      },
      {
        key: 'status',
        header: 'State',
        accessor: (r) => r.status,
        sortable: true,
        render: (r) => (
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill label={revisionStatusLabel(r.status)} tone={revisionStatusTone(r.status)} />
            {r.status === 'superseded' ? (
              <span className="text-meta text-muted-foreground">
                Superseded by revision{' '}
                {r.supersededBy ? (numberById.get(r.supersededBy) ?? '(another report?)') : '?'} —
                its frozen snapshot is unchanged
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'decision',
        header: 'Decision',
        accessor: (r) => r.decision,
        render: (r) => <span>{decisionLabel(r.decision)}</span>,
      },
      {
        key: 'reviewedAt',
        header: 'Locked for review',
        accessor: (r) => r.reviewedAt,
        sortable: true,
        sortValue: (r) => r.reviewedAt ?? '',
        emptyLabel: 'Not locked',
        render: (r) =>
          r.reviewedAt ? <Timestamp value={r.reviewedAt} /> : <span className="text-muted-foreground">Not locked</span>,
      },
      {
        key: 'publishedAt',
        header: 'Released',
        accessor: (r) => r.publishedAt,
        sortable: true,
        sortValue: (r) => r.publishedAt ?? '',
        render: (r) =>
          r.publishedAt ? (
            <Timestamp value={r.publishedAt} />
          ) : r.withdrawnAt ? (
            <span className="text-muted-foreground">
              Withdrawn <Timestamp value={r.withdrawnAt} />
            </span>
          ) : (
            <span className="text-muted-foreground">Not released</span>
          ),
      },
      {
        key: 'decisionNote',
        header: 'Recorded note',
        accessor: (r) => r.decisionNote,
        render: (r) =>
          r.decisionNote ? (
            <span className="text-muted-foreground">{r.decisionNote}</span>
          ) : (
            <span className="text-muted-foreground">No note</span>
          ),
      },
    ];
  }, [lifecycle]);

  const publicUrl = `/shared/reports/${projectId}/${slug}`;
  const visibility = lifecycle?.visibility ?? 'private';
  const visibilityTarget: 'private' | 'public' = visibility === 'public' ? 'private' : 'public';

  const expiresValid =
    expiresInHours.trim() === '' || /^[1-9][0-9]*$/.test(expiresInHours.trim());

  const onCopy = useCallback(async () => {
    if (!createdLink || !origin) return;
    try {
      await navigator.clipboard.writeText(shareLinkAbsoluteUrl(createdLink, origin));
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the value stays on screen and
      // selectable, which is the fallback rather than a failure message.
      setCopied(false);
    }
  }, [createdLink, origin]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Report review" />
        {/* §4.1 — a missing report and one belonging to another project read
            identically, so this page cannot be used to probe for slugs. */}
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!report || !lifecycle || !facts || !nextStep) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: row?.projectName ?? report.title,
          domain: report.targetUrl,
          mode: 'snapshot',
          snapshotLabel: revisionDetail
            ? `Revision ${revisionDetail.revision} locked ${new Date(revisionDetail.snapshot.snapshotAt).toLocaleDateString()}`
            : `Prepared ${new Date(report.createdAt).toLocaleDateString()}`,
          runLabel: releasedRevision !== null ? `Released revision ${releasedRevision}` : undefined,
        }}
      />

      <PageHeader
        breadcrumbs={[
          { label: 'Reports', href: `/projects/${projectId}/reports` },
          { label: report.title, href: `/projects/${projectId}/reports/${slug}` },
          { label: 'Review & release' },
        ]}
        title="Review & release"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{report.slug}</span>
            <span className="text-meta text-muted-foreground">
              Prepared <Timestamp value={report.createdAt} />
            </span>
          </span>
        }
        status={
          <span className="flex flex-wrap items-center gap-2">
            {/* Two pills, two axes, and they are never merged into one. */}
            <StatusPill
              label={revisionStatusLabel(lifecycle.status)}
              tone={revisionStatusTone(lifecycle.status)}
            />
            {visibility === 'public' ? (
              <StatusPill label="Anyone with link" tone="warning" />
            ) : (
              <StatusPill label="No public link" tone="neutral" />
            )}
          </span>
        }
        secondaryActions={
          <span className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/reports/${slug}`}>Read the report</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a
                href={reportRenderUrl(projectId, slug)}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink aria-hidden="true" className="mr-2 h-4 w-4" />
                Preview rendered
              </a>
            </Button>
          </span>
        }
      />

      {/* ── The release-safety fact that outranks every control here ────── */}
      {isReleased ? (
        <Alert>
          <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
          <AlertTitle>Revision {releasedRevision} is live in the client&apos;s portal</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>
              That client can read it now, and this revision is frozen: its stored snapshot was
              written once when it was locked for review and no later action rewrites it.
            </p>
            {inFlight ? (
              <p>
                Revision {inFlight.revision} is being prepared. The client keeps reading revision{' '}
                {releasedRevision} until revision {inFlight.revision} is released, so nothing here
                takes it away from them.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <Info aria-hidden="true" className="h-4 w-4 text-warning" />
          <AlertTitle>Nothing here is visible to the client yet</AlertTitle>
          <AlertDescription>
            This report is <strong className="font-medium">{lifecycle.status}</strong> and no
            revision is released, so the client&apos;s portal does not serve it at all — a draft,
            an in-review, an approved-but-unreleased and a withdrawn report all read as not found
            there. A public link, if one exists, is a separate thing from this: it is not a
            release, and the card for it below says exactly what it does.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Axis one: the editorial lifecycle ───────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Editorial lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            This axis answers one question: has this report been reviewed, approved and released to
            its client? It is changed by the review, approve, release and withdraw actions, and by
            nothing else on this page.
          </p>

          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-meta text-muted-foreground">Report state</dt>
              <dd className="mt-1">
                <StatusPill
                  label={revisionStatusLabel(lifecycle.status)}
                  tone={revisionStatusTone(lifecycle.status)}
                />
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Released revision</dt>
              <dd className="mt-1 text-table">
                {releasedRevision !== null ? (
                  <span className="font-medium">Revision {releasedRevision}</span>
                ) : (
                  <span className="text-muted-foreground">No revision has been released.</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Released at</dt>
              <dd className="mt-1 text-table">
                {lifecycle.releasedAt ? (
                  <Timestamp value={lifecycle.releasedAt} />
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </dd>
            </div>
          </dl>

          {releasedRevision !== null ? (
            <p className="text-meta text-muted-foreground">
              Revision {releasedRevision} is frozen. New audits and new runs do not rewrite it —
              they change what a <em>new</em> revision would contain, and that revision exists only
              once it is locked, approved and released.
              {lifecycle.releasedBy ? (
                <>
                  {' '}
                  Released by <span className="font-mono">{lifecycle.releasedBy}</span>.
                </>
              ) : null}
            </p>
          ) : null}

          <Separator />

          {/* ── The one valid next step ─────────────────────────────────── */}
          {nextStep.kind === 'unavailable' ? (
            <EmptyState
              variant="not-measured"
              subject="a valid next editorial step for this report"
              prerequisite={nextStep.reason}
            />
          ) : null}

          {nextStep.kind === 'review' ? (
            <div className="space-y-3">
              <div>
                <div className="text-table font-medium">{nextStep.label}</div>
                <p className="mt-1 text-meta text-muted-foreground">{nextStep.detail}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="review-note">Note (optional)</Label>
                <Input
                  id="review-note"
                  value={reviewNote}
                  maxLength={500}
                  onChange={(event) => setReviewNote(event.target.value)}
                  aria-describedby="review-note-help"
                />
                <p id="review-note-help" className="text-meta text-muted-foreground">
                  Recorded on the revision as why it was locked. Visible to operators; it is not
                  shown to the client.
                </p>
              </div>
              <Button onClick={() => setReviewOpen(true)}>
                <Lock aria-hidden="true" className="mr-2 h-4 w-4" />
                {nextStep.label}
              </Button>
            </div>
          ) : null}

          {nextStep.kind === 'decide' ? (
            <div className="space-y-3">
              <p className="text-table text-muted-foreground">
                The decision below binds to revision {nextStep.revision.revision} specifically. The
                snapshot it was locked with is what a client would read if it is released, so read
                that version — not a newer live row — before deciding.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="decision-note">Decision note (optional)</Label>
                <Input
                  id="decision-note"
                  value={decisionNote}
                  maxLength={500}
                  onChange={(event) => setDecisionNote(event.target.value)}
                  aria-describedby="decision-note-help"
                />
                <p id="decision-note-help" className="text-meta text-muted-foreground">
                  Recorded against this revision with the decision. Use it to say what was checked,
                  or what has to change before the next review.
                </p>
              </div>
              <ApprovalCard
                item={toApprovalItem(nextStep.revision)}
                // The route accepts exactly two decisions; `rejected` is not a
                // revision state, so it is not offered.
                allowedDecisions={['approved', 'changes-requested']}
                href={`/projects/${projectId}/reports/${slug}`}
                onDecide={async (decision) => {
                  await decideReportRevision(
                    projectId,
                    slug,
                    decision === 'approved' ? 'approved' : 'changes-requested',
                    decisionNote.trim() || undefined,
                  );
                  setNotice(
                    decision === 'approved'
                      ? `Revision ${nextStep.revision.revision} is approved. It is not released yet — the release step below is separate.`
                      : `Changes requested on revision ${nextStep.revision.revision}. It is back to draft; locking it again re-freezes it from the current content.`,
                  );
                  setDecisionNote('');
                  await load();
                }}
              >
                <p className="text-meta text-muted-foreground">
                  Requestor and reviewer are the operator ids the server recorded. This route
                  returns ids, not names — so an id here is the real recorded actor, and a blank is
                  genuinely unrecorded.
                </p>
              </ApprovalCard>
            </div>
          ) : null}

          {nextStep.kind === 'publish' ? (
            <div className="space-y-3">
              <div>
                <div className="text-table font-medium">
                  Release revision {nextStep.revision.revision} to the client
                </div>
                <p className="mt-1 text-meta text-muted-foreground">
                  Releasing puts this exact frozen revision in the client&apos;s portal. It sends
                  nothing and it creates no public link — those are separate actions, in the
                  delivery screen and in the public-sharing card below.
                </p>
              </div>

              {nextStep.blocked ? (
                <Alert>
                  <CircleAlert aria-hidden="true" className="h-4 w-4 text-danger" />
                  <AlertTitle>Release is currently refused: {nextStep.blocked.reason}</AlertTitle>
                  <AlertDescription className="space-y-1">
                    <p>{nextStep.blocked.message}</p>
                    <p>
                      This is the release gate&apos;s own verdict, read from the report&apos;s
                      lifecycle. It re-runs when release is attempted, so resolving it outside this
                      screen is what makes the control available — not a retry here.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="release-note">Release note (optional)</Label>
                <Input
                  id="release-note"
                  value={releaseNote}
                  maxLength={500}
                  onChange={(event) => setReleaseNote(event.target.value)}
                  aria-describedby="release-note-help"
                />
                <p id="release-note-help" className="text-meta text-muted-foreground">
                  Recorded on the revision at release. It is internal context, not client-facing
                  copy.
                </p>
              </div>

              <Button
                onClick={() => setReleaseOpen(true)}
                disabled={nextStep.blocked !== null}
                aria-describedby={nextStep.blocked ? 'release-blocked-reason' : undefined}
              >
                <Send aria-hidden="true" className="mr-2 h-4 w-4" />
                Release revision {nextStep.revision.revision} to the client
              </Button>
              {nextStep.blocked ? (
                // The disabled state always carries its reason as text, not
                // only as a tooltip (§3.4).
                <p id="release-blocked-reason" className="text-meta text-danger-foreground">
                  Unavailable because the release gate refused: {nextStep.blocked.reason}.
                </p>
              ) : (
                <p className="text-meta text-muted-foreground">
                  The gate is checked again when you release. If it refuses, nothing is written and
                  the refusal is shown in full.
                </p>
              )}
            </div>
          ) : null}

          {/* ── Withdraw: only while something is actually released ─────── */}
          {releasedRevision !== null ? (
            <>
              <Separator />
              <div className="space-y-3">
                <div className="text-table font-medium">
                  Withdraw revision {releasedRevision} from the client
                </div>
                <p className="text-meta text-muted-foreground">
                  The client&apos;s portal stops serving this report and every share link for it
                  stops resolving, both immediately. The revision keeps its frozen snapshot and
                  gains a withdrawal record, so what was pulled is still auditable. A reason is
                  required — it is recorded on the revision.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="withdraw-reason">Reason (required)</Label>
                  <Input
                    id="withdraw-reason"
                    value={withdrawReason}
                    maxLength={500}
                    onChange={(event) => setWithdrawReason(event.target.value)}
                    aria-describedby="withdraw-reason-help"
                    aria-invalid={withdrawReason.trim().length === 0}
                  />
                  <p id="withdraw-reason-help" className="text-meta text-muted-foreground">
                    Recorded verbatim with the withdrawal. Say what was wrong and what replaces it.
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="border-danger/40 text-danger-foreground hover:bg-danger-subtle"
                  onClick={() => setWithdrawOpen(true)}
                  disabled={withdrawReason.trim().length === 0}
                  aria-describedby="withdraw-disabled-reason"
                >
                  Withdraw revision {releasedRevision}
                </Button>
                {withdrawReason.trim().length === 0 ? (
                  <p id="withdraw-disabled-reason" className="text-meta text-muted-foreground">
                    Enter a reason above to enable this. The server refuses a withdrawal without
                    one.
                  </p>
                ) : null}
              </div>
            </>
          ) : null}

          {notice ? (
            <p role="status" className="text-meta text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── The revision history ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Revision history</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-meta text-muted-foreground">
            Newest first. A released, withdrawn or superseded revision is immutable — its stored
            snapshot is the bytes a reader was served, and it is never rewritten afterwards.
          </p>
          <DataTable<ReportRevisionRow>
            columns={revisionColumns}
            rows={lifecycle.revisions}
            getRowId={(r) => r.id}
            caption="Report revisions"
            ariaLabel="Report revisions"
            defaultSort={{ key: 'revision', direction: 'desc' }}
            minTableWidth="52rem"
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="a revision for this report"
                prerequisite="No revision has been locked. Revision 1 is created when the content is first locked for review."
              />
            }
          />
        </CardContent>
      </Card>

      {/* ── Axis two: the public link (not a release) ───────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Public sharing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            This is a separate axis from release, and it is changed by different actions. It governs
            one thing: whether a URL exists that opens this report with no sign-in at all. It does
            not make the report approved, and turning it off does not un-release anything.
          </p>

          {!isReleased ? (
            <Alert>
              <CircleAlert aria-hidden="true" className="h-4 w-4 text-warning" />
              <AlertTitle>Not a QA state — and it does not hide a draft</AlertTitle>
              <AlertDescription>
                This report is not released, and a public URL is not an alternative to releasing it:
                the client&apos;s portal will still not serve it. Be aware of what this flag
                actually does while the report is unreleased — it serves the report&apos;s{' '}
                <strong className="font-medium">current live content</strong> to anyone with the
                URL, including content that has never been reviewed or approved.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1">
            <div className="text-meta text-muted-foreground">Public URL</div>
            <div className="break-all font-mono text-table">
              {origin ? `${origin}${publicUrl}` : publicUrl}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {visibility === 'public' ? (
              <>
                <Button asChild variant="outline" size="sm">
                  <a href={publicUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink aria-hidden="true" className="mr-2 h-4 w-4" />
                    Open the public link
                  </a>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setVisibilityOpen(true)}>
                  Turn off the public link
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setVisibilityOpen(true)}>
                Turn on the public link
              </Button>
            )}
          </div>

          {visibility === 'public' ? (
            <Alert>
              <CircleAlert aria-hidden="true" className="h-4 w-4 text-warning" />
              <AlertTitle>Anyone with the link can read this report</AlertTitle>
              <AlertDescription>
                No sign-in, no client account, and no way to limit it to one person. The rendered
                page asks search engines not to index it, but a noindex directive is not access
                control — treat the URL as public the moment it is shared. Note that a signed-in
                operator sees this URL even when the flag is private, so testing it while signed in
                proves nothing about what a stranger sees.
              </AlertDescription>
            </Alert>
          ) : null}

          <Separator />

          {/* ── Share links: the revocable, expiring form of "anyone with the link" ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Link2 aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              <div className="text-table font-medium">Share links</div>
            </div>
            <p className="text-meta text-muted-foreground">
              A share link is a capability: an unguessable URL that opens the report&apos;s currently
              released revision, can expire, and can be revoked immediately. It is a better answer
              than the flag above when you are sending a report to someone outside the portal.
            </p>

            {lifecycle.status !== 'released' || releasedRevision === null ? (
              <EmptyState
                variant="not-measured"
                subject="a share link for this report"
                prerequisite="A share link can only point at a released report — §6.4 excludes unpublished drafts from the public projection, and the route refuses anything else. Release a revision first."
              />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="share-expiry">Expires in (hours)</Label>
                    <Input
                      id="share-expiry"
                      inputMode="numeric"
                      value={expiresInHours}
                      onChange={(event) => setExpiresInHours(event.target.value)}
                      aria-describedby="share-expiry-help"
                      aria-invalid={!expiresValid}
                      className="w-40"
                    />
                  </div>
                  <Button
                    disabled={!expiresValid || creatingLink}
                    onClick={async () => {
                      setCreatingLink(true);
                      setCreateLinkError(null);
                      try {
                        const created = await createReportShareLink(
                          projectId,
                          slug,
                          expiresInHours.trim() === '' ? undefined : Number(expiresInHours.trim()),
                        );
                        setCreatedLink(created);
                        setCopied(false);
                        setExpiresInHours('');
                        setNotice(
                          'Share link created. It resolves to the report’s currently released revision — a later release serves the newer one under the same link.',
                        );
                        await load();
                      } catch (caught) {
                        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
                          setCreateLinkError(toApiError(caught));
                        }
                      } finally {
                        setCreatingLink(false);
                      }
                    }}
                  >
                    {creatingLink ? 'Creating…' : 'Create a share link'}
                  </Button>
                </div>
                <p id="share-expiry-help" className="text-meta text-muted-foreground">
                  Leave it empty for a link that does not expire — it is still revocable, and
                  revoking is what you should rely on. The report keeps being served until the link
                  is revoked, expired, or the report is withdrawn.
                </p>
                {!expiresValid ? (
                  <p className="text-meta text-danger-foreground">
                    An expiry has to be a whole number of hours, 1 or more. Clear the field for a
                    non-expiring link.
                  </p>
                ) : null}
                {createLinkError ? (
                  <ErrorState error={createLinkError} layout="inline" />
                ) : null}
              </div>
            )}

            {createdLink && origin ? (
              <Card className="border-warning/40 bg-warning-subtle">
                <CardHeader>
                  <CardTitle className="text-subsection">Copy this link now</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-table">
                    This is the only time it will be shown. The server stores only a hash of the
                    token, so it cannot be retrieved, re-sent or looked up later — not by you and
                    not by an administrator. If you lose it, revoke it and create another.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="share-link-value">Share link</Label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        id="share-link-value"
                        readOnly
                        value={shareLinkAbsoluteUrl(createdLink, origin)}
                        className="min-w-0 flex-1 font-mono"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <Button type="button" variant="outline" onClick={() => void onCopy()}>
                        <Copy aria-hidden="true" className="mr-2 h-4 w-4" />
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    {createdLink.expiresAt ? (
                      <>
                        Stops working <Timestamp value={createdLink.expiresAt} />.
                      </>
                    ) : (
                      <>No expiry. It works until it is revoked or the report is withdrawn.</>
                    )}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={shareLinkAbsoluteUrl(createdLink, origin)}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <ExternalLink aria-hidden="true" className="mr-2 h-4 w-4" />
                        Open it as the recipient will
                      </a>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setCreatedLink(null)}
                    >
                      I have copied it — hide it
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {links === null ? (
              <p className="text-meta text-muted-foreground">
                The share-link list could not be read. Links may exist that are not shown here;
                reload to try again.
              </p>
            ) : links.length === 0 ? (
              <p className="text-meta text-muted-foreground">
                No share link exists for this report.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {links.map((link) => {
                  const revoked = link.revokedAt !== null;
                  const expired =
                    !revoked && link.expiresAt !== null && new Date(link.expiresAt) <= new Date();
                  return (
                    <li key={link.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-meta">{link.id}</span>
                          {revoked ? (
                            <StatusPill label="Revoked" tone="neutral" />
                          ) : expired ? (
                            <StatusPill label="Expired" tone="unmeasured" />
                          ) : (
                            <StatusPill label="Live" tone="success" />
                          )}
                        </div>
                        <div className="text-meta text-muted-foreground">
                          Created <Timestamp value={link.createdAt} />
                          {link.expiresAt ? (
                            <>
                              {' · '}Expires <Timestamp value={link.expiresAt} />
                            </>
                          ) : (
                            <> · No expiry</>
                          )}
                          {revoked ? (
                            <>
                              {' · '}Revoked <Timestamp value={link.revokedAt as string} />
                            </>
                          ) : null}
                        </div>
                        <div className="text-meta text-muted-foreground">
                          {link.viewCount === 0
                            ? 'Not opened yet.'
                            : `Opened ${link.viewCount} time(s)${
                                link.lastViewedAt ? ', most recently' : ''
                              }.`}{' '}
                          {link.lastViewedAt ? <Timestamp value={link.lastViewedAt} /> : null}
                          {' '}View counts are requests for this link, not a record that a person
                          read the report.
                        </div>
                      </div>
                      {!revoked ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-danger/40 text-danger-foreground hover:bg-danger-subtle"
                          onClick={() => setRevokeTarget(link)}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── The checklist ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Review checklist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-table text-muted-foreground">
            Evaluated against {facts.source}. Each line is read from the stored artifact — none of
            them can be marked done without evidence, and an item shown as undetermined is one the
            snapshot genuinely does not record.
          </p>
          <ul className="divide-y divide-border">
            {checklist.map((item) => (
              <li key={item.label} className="flex gap-3 py-3">
                {item.ok === true ? (
                  <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : (
                  <CircleAlert
                    aria-hidden="true"
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      item.ok === false ? 'text-danger' : 'text-unmeasured'
                    }`}
                  />
                )}
                <div className="min-w-0">
                  <div className="text-table font-medium">
                    {item.label}
                    {item.ok === false ? <span className="sr-only"> — needs attention</span> : null}
                    {item.ok === null ? <span className="sr-only"> — undetermined</span> : null}
                  </div>
                  <div className="mt-0.5 text-meta text-muted-foreground">{item.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {coverage ? (
        <CoveragePanel
          summary={coverage}
          title="Evidence coverage for this snapshot"
          contextNote={
            manifest?.freshness?.statement ??
            'Counts come from the evidence manifest this report pinned.'
          }
        />
      ) : (
        <EmptyState
          variant="not-measured"
          subject="this report's evidence coverage"
          prerequisite="No evidence manifest is pinned to this report, so how much of the agreed evidence returned is unrecorded — not zero."
        />
      )}

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}

      {nextStep.kind === 'review' ? (
        <ConfirmDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          title={nextStep.label}
          targetLabel="Report"
          target={report.slug}
          confirmLabel={nextStep.label}
          effect={
            <>
              The report&apos;s current content is frozen into a revision and marked in review. The
              client sees nothing new either way: a revision that has not been released is not
              served by their portal.
            </>
          }
          scope={
            releasedRevision !== null
              ? `Revision ${releasedRevision} stays live for the client and keeps its frozen snapshot until a newer revision is released.`
              : 'This report has never been released, so no client-visible copy exists to change.'
          }
          onConfirm={async () => {
            await reviewReport(projectId, slug, reviewNote.trim() || undefined);
          }}
          onConfirmed={() => {
            setReviewOpen(false);
            setReviewNote('');
            setNotice('Snapshot locked for review. The revision number is in the history below.');
            void load();
          }}
        >
          <p className="text-meta text-muted-foreground">
            Locking for review is not approval and not release. Both come after, and both are
            recorded against this revision number.
          </p>
        </ConfirmDialog>
      ) : null}

      {nextStep.kind === 'publish' ? (
        <ConfirmDialog
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
          title={`Release revision ${nextStep.revision.revision}`}
          targetLabel="Report"
          target={report.slug}
          confirmLabel={`Release revision ${nextStep.revision.revision} to the client`}
          effect={
            <>
              The client&apos;s portal starts serving revision {nextStep.revision.revision} — the
              snapshot frozen when it was locked, not the current live row.
              {releasedRevision !== null && releasedRevision !== nextStep.revision.revision ? (
                <>
                  {' '}
                  Revision {releasedRevision} stops being the released version and is marked
                  superseded; its frozen content is not changed or deleted.
                </>
              ) : null}
            </>
          }
          scope="This client's portal only. No email is sent and no public link is created — those are separate actions."
          onConfirm={async () => {
            await publishReport(projectId, slug, releaseNote.trim() || undefined);
          }}
          onConfirmed={() => {
            setReleaseOpen(false);
            setReleaseNote('');
            setNotice(
              `Revision ${nextStep.revision.revision} released. The client can read it now; nothing has been emailed.`,
            );
            void load();
          }}
        >
          <p className="text-meta text-muted-foreground">
            The release gate is checked as part of this action. If it refuses, nothing is written
            and the refusal is shown in this window.
          </p>
        </ConfirmDialog>
      ) : null}

      <ConfirmDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        title={`Withdraw revision ${releasedRevision ?? ''} from the client`}
        targetLabel="Report"
        target={report.slug}
        confirmLabel="Withdraw the released report"
        destructive
        effect={
          <>
            The client&apos;s portal stops serving this report immediately, and every share link for
            it stops resolving. The withdrawn revision keeps its frozen snapshot and records who
            withdrew it and why.
          </>
        }
        scope="Affects the client's read and every share link. It does not delete the revision, its snapshot, or the recorded decisions."
        onConfirm={async () => {
          await withdrawReport(projectId, slug, withdrawReason.trim());
        }}
        onConfirmed={() => {
          setWithdrawOpen(false);
          setWithdrawReason('');
          setNotice(
            'Released revision withdrawn. The client can no longer read it, and any share link for this report stops resolving.',
          );
          void load();
        }}
      >
        <p className="text-meta text-muted-foreground">
          Reason recorded: {withdrawReason.trim() || '(none entered)'}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={visibilityOpen}
        onOpenChange={setVisibilityOpen}
        title={visibilityTarget === 'public' ? 'Turn on the public link' : 'Turn off the public link'}
        targetLabel="Report"
        target={report.slug}
        confirmLabel={
          visibilityTarget === 'public' ? 'Turn on the public link' : 'Turn off the public link'
        }
        effect={
          visibilityTarget === 'public' ? (
            <>
              Anyone with the URL <span className="break-all font-mono">{origin || ''}{publicUrl}</span>{' '}
              can read this report — no sign-in, no client account, no way to limit it to one
              person. Search engines are asked not to index it, but that is not access control.
            </>
          ) : (
            <>
              The URL <span className="break-all font-mono">{origin || ''}{publicUrl}</span> stops
              working for everyone. Anyone who already has it will see the same page a stranger sees
              for a private report.
            </>
          )
        }
        scope={
          visibilityTarget === 'public'
            ? 'Unlocks unauthenticated readers only. It does not release the report to the client, does not make it approved, and does not create a share link.'
            : 'Affects unauthenticated readers only. The client portal copy and this project’s operator access are unaffected, and no release state changes.'
        }
        onConfirm={async () => {
          const answer = await setReportVisibility(projectId, slug, visibilityTarget);
          // Render the server's answer, not the request: a screen that showed
          // "public" for a write the server refused would be describing a link
          // that does not exist.
          if (answer.visibility !== visibilityTarget) {
            throw new Error(
              `The server reported visibility "${answer.visibility}" after a request for "${visibilityTarget}".`,
            );
          }
        }}
        onConfirmed={() => {
          setVisibilityOpen(false);
          setNotice(
            visibilityTarget === 'public'
              ? 'Public link on. The server confirms the stored visibility is public.'
              : 'Public link off. The server confirms the stored visibility is private; release state is untouched.',
          );
          void load();
        }}
      >
        <p className="text-meta text-muted-foreground">
          The report&apos;s contents and its editorial state are unchanged either way. New runs will
          not rewrite a released revision; a newer report is a separate revision.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke share link"
        targetLabel="Share link"
        target={revokeTarget ? `${revokeTarget.id}` : ''}
        confirmLabel="Revoke share link"
        destructive
        confirmPhrase="revoke"
        effect={
          <>
            The link stops resolving on the next request — anyone holding it gets the same 404 a
            stranger gets. This cannot be undone: a revoked link cannot be un-revoked, and the raw
            token cannot be recovered, so a replacement link has to be created.
          </>
        }
        scope="Affects this link only. The report stays released, the public-link flag above is untouched, and the client's portal copy keeps working."
        onConfirm={async () => {
          if (!revokeTarget) return;
          await revokeReportShareLink(projectId, slug, revokeTarget.id);
        }}
        onConfirmed={() => {
          setRevokeTarget(null);
          setNotice('Share link revoked. The report itself is unchanged and still released.');
          void load();
        }}
      >
        <p className="text-meta text-muted-foreground">
          Revoking is independent of release: it never withdraws the report from the client and
          never changes the public-link flag.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * The QA decision as `ApprovalCard` reads it.
 *
 * `decision: 'pending'` is the absence of a decision, which is exactly what an
 * in-review revision is. The card is only rendered in that state, so the
 * mapping cannot claim a decision that was never recorded.
 */
function toApprovalItem(revision: ReportRevisionRow): ApprovalItem {
  return {
    id: revision.id,
    version: `Revision ${revision.revision}`,
    requestor: revision.createdBy ?? 'Not recorded',
    reviewer: revision.reviewedBy ?? undefined,
    decisionRequested: `Approve revision ${revision.revision} for release to the client`,
    decision: 'pending',
  };
}
