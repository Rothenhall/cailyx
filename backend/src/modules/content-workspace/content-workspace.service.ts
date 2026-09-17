/**
 * Content Workspace Service — P08 (platform_improvement_plan.md §13.1-13.5,
 * §13.9-13.11).
 *
 * Composes existing records — GrowthAsset (growth-execution), ContentBrief /
 * ContentRevision (content), ApprovalRequest / CheckResult (approvals),
 * Publication (publishing) — into ONE canonical content list/detail with
 * correctly separated state axes (§13.4). Does not reimplement generation,
 * approvals or publishing; reads their tables directly (same "read-only
 * reuse of another module's tables" pattern already used across this
 * codebase, e.g. gap-analysis reading Gap for growth-execution) because a
 * cross-cutting workspace view needs joins none of those modules' own
 * service methods return in one shape.
 *
 * Filtering/pagination note: every list read goes through ONE predicate,
 * `matchesFilters`, applied to the same enriched view-model array that
 * produces the paginated page AND the total count — never two divergent
 * code paths. At today's per-project content volume this predicate runs
 * in-process after one batched fetch (five queries total, regardless of
 * asset count) rather than as a SQL WHERE clause; if a project's content
 * volume ever outgrows that, the fetch should move server-side into SQL,
 * but the shared-predicate discipline this comment describes should not
 * change when it does.
 *
 * @module content-workspace.service
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  ALL_TRACKED_ASSET_TYPES,
  CONTENT_WORKSPACE_ASSET_TYPES,
  GENERATION_IMPLEMENTED_ASSET_TYPES,
  type CapabilityDto,
  type ClientReviewState,
  type ContentWorkspaceAssetType,
  type ContentWorkspaceDetailDto,
  type ContentWorkspaceItemDto,
  type ContentWorkspaceListQuery,
  type EditorialState,
  type PlacementSummaryDto,
  type PublicationSummaryDto,
  type PublicationSummaryState,
  type UpdateState,
} from './content-workspace.types';

const ASSET_TYPE_LABELS: Record<string, string> = {
  article: 'Article / Guide',
  'ad-copy': 'Ad Copy',
  'social-content': 'Social Content',
  'email-campaign': 'Email Campaign',
  'landing-page': 'Landing Page',
  faq: 'FAQ / Knowledge Content',
  'structured-data': 'Structured Data (website work)',
  'seo-fix': 'SEO Fix (team work)',
  'review-campaign': 'Review / Reputation Campaign',
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isContentAssetType(assetType: string): assetType is ContentWorkspaceAssetType {
  return (CONTENT_WORKSPACE_ASSET_TYPES as readonly string[]).includes(assetType);
}

type AssetRow = Awaited<ReturnType<PrismaService['growthAsset']['findMany']>>[number];
type RevisionRow = Awaited<ReturnType<PrismaService['contentRevision']['findMany']>>[number];
type ApprovalRow = Awaited<ReturnType<PrismaService['approvalRequest']['findMany']>>[number];
type PublicationRow = Awaited<ReturnType<PrismaService['publication']['findMany']>>[number];
type BriefRow = Awaited<ReturnType<PrismaService['contentBrief']['findMany']>>[number];

interface Bundle {
  asset: AssetRow;
  revisions: RevisionRow[]; // newest first
  latestRevision: RevisionRow | null;
  latestClientVisible: RevisionRow | null;
  approvals: ApprovalRow[]; // newest first
  publications: PublicationRow[];
  brief: BriefRow | null;
}

@Injectable()
export class ContentWorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── §13.9 type capability matrix ──────────────────────────────────

  capabilities(): { capabilities: CapabilityDto[] } {
    const capabilities: CapabilityDto[] = ALL_TRACKED_ASSET_TYPES.map((assetType) => {
      const countsAsContent = (CONTENT_WORKSPACE_ASSET_TYPES as readonly string[]).includes(assetType);
      const generationImplemented = (GENERATION_IMPLEMENTED_ASSET_TYPES as readonly string[]).includes(assetType);
      return {
        assetType,
        label: ASSET_TYPE_LABELS[assetType] ?? assetType,
        generationImplemented,
        manualPlanningAvailable: true,
        countsAsContent,
        note: !countsAsContent
          ? 'Tracked record, not counted as content in this workspace’s calendar/delivery counts (§13.9). Preserved with its cross-links.'
          : generationImplemented
            ? 'A tested writer exists — generation is offered after brief/permission/budget gates.'
            : 'No tested writer for this type yet. Manual planning/editing only; generation is not offered here (would be simulating a capability that does not exist).',
      };
    });
    return { capabilities };
  }

  // ─── §13.3 canonical list ───────────────────────────────────────────

  async list(projectId: string, query: ContentWorkspaceListQuery): Promise<{ items: ContentWorkspaceItemDto[]; total: number; page: number; pageSize: number }> {
    await this.ensureProject(projectId);
    const bundles = await this.loadBundles(projectId);
    // §13.3 asks the search to cover "title/topic". The topic is the piece's
    // plan (its title and target query) — a search term that only matched the
    // asset row would miss exactly the words the operator typed from the brief.
    const items = bundles.map((b) => ({
      dto: this.toItemDto(b),
      topic: `${b.brief?.title ?? ''} ${b.brief?.targetQuery ?? ''}`.toLowerCase(),
    }));

    const filtered = items
      .filter((entry) => this.matchesFilters(entry.dto, query, entry.topic))
      .map((entry) => entry.dto);

    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 25;
    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    return { items: paged, total: filtered.length, page, pageSize };
  }

  /** The ONE predicate used by both the paginated list and its count — see module header. */
  private matchesFilters(
    item: ContentWorkspaceItemDto,
    query: ContentWorkspaceListQuery,
    /** Lower-cased plan title + target query, so `q` covers title *and* topic (§13.3). */
    topic = '',
  ): boolean {
    if (!this.matchesView(item, query.view)) return false;
    if (query.q) {
      const q = query.q.trim().toLowerCase();
      if (q && !item.title.toLowerCase().includes(q) && !topic.includes(q)) return false;
    }
    if (query.assetType && item.assetType !== query.assetType) return false;
    if (query.editorialState && item.editorialState !== query.editorialState) return false;
    if (query.source && item.source !== query.source) return false;
    if (query.market && (item.market ?? '') !== query.market) return false;
    if (query.language && (item.language ?? '') !== query.language) return false;
    if (query.assigneeId && item.assigneeId !== query.assigneeId) return false;
    if (query.clientVisibility === 'shared' && item.clientReviewState === 'not-shared') return false;
    if (query.clientVisibility === 'not-shared' && item.clientReviewState !== 'not-shared') return false;
    return true;
  }

  /**
   * §13.1's saved views, evaluated on the derived axes rather than on one
   * flattened status — which is the whole point of §13.4. "In progress" is
   * true of a piece that has a live publication *and* a newer draft, and
   * "Published" stays true of that same piece; the two views overlap on
   * purpose rather than being mutually exclusive stages.
   */
  private matchesView(item: ContentWorkspaceItemDto, view: string | undefined): boolean {
    switch (view) {
      case undefined:
      case '':
      case 'all':
        return true;
      case 'in-progress':
        return (
          item.updateState === 'revision-in-progress' ||
          ['drafting', 'draft', 'internal-review', 'changes-requested'].includes(item.editorialState)
        );
      case 'needs-review':
        return (
          ['internal-review', 'ready-for-client', 'changes-requested'].includes(item.editorialState) ||
          ['awaiting-review', 'changes-requested'].includes(item.clientReviewState)
        );
      case 'scheduled':
        return ['planned', 'scheduled', 'publishing'].includes(item.publicationSummary.status);
      case 'published':
        return item.publicationSummary.status === 'published';
      case 'updating':
        return item.updateState === 'revision-in-progress';
      default:
        // An unknown view must not silently mean "everything" — that would
        // make a typo in a saved link look like a working filter. The DTO
        // rejects unknown values before they reach here; this is the belt.
        return false;
    }
  }

  // ─── §13.5 detail ────────────────────────────────────────────────────

  async detail(projectId: string, assetId: string): Promise<ContentWorkspaceDetailDto> {
    const bundle = await this.loadBundle(projectId, assetId);
    if (!bundle) throw new NotFoundException(`Content ${assetId} not found for project ${projectId}`);
    const item = this.toItemDto(bundle);

    return {
      ...item,
      brief: bundle.brief
        ? {
            id: bundle.brief.id,
            briefFamilyId: bundle.brief.briefFamilyId,
            version: bundle.brief.version,
            title: bundle.brief.title,
            audience: bundle.brief.audience,
            intent: bundle.brief.intent,
            angle: bundle.brief.angle,
            mustInclude: parseJson<string[]>(bundle.brief.mustInclude, []),
            references: parseJson<{ url: string; note?: string }[]>(bundle.brief.references, []),
            wordTarget: bundle.brief.wordTarget,
            status: bundle.brief.status,
          }
        : null,
      currentRevision: bundle.latestRevision
        ? {
            id: bundle.latestRevision.id,
            revision: bundle.latestRevision.revision,
            title: bundle.latestRevision.title,
            body: bundle.latestRevision.body,
            fields: parseJson<Record<string, unknown>>(bundle.latestRevision.fields, {}),
            wordCount: bundle.latestRevision.wordCount,
            origin: bundle.latestRevision.origin,
            clientVisible: bundle.latestRevision.clientVisible,
            createdAt: bundle.latestRevision.createdAt.toISOString(),
          }
        : null,
      revisions: bundle.revisions.map((r) => ({
        id: r.id,
        revision: r.revision,
        origin: r.origin,
        authorId: r.authorId,
        wordCount: r.wordCount,
        clientVisible: r.clientVisible,
        clientVisibleAt: r.clientVisibleAt ? r.clientVisibleAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      approvals: bundle.approvals.map((a) => ({
        id: a.id,
        reviewerType: a.reviewerType,
        status: a.status,
        artifactRevision: a.artifactRevision,
        revisionId: a.revisionId,
        dueAt: a.dueAt ? a.dueAt.toISOString() : null,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      })),
      checks: (
        await this.prisma.checkResult.findMany({
          where: { subjectType: 'content-revision', subjectId: { in: bundle.revisions.map((r) => r.id) } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      ).map((c) => ({ id: c.id, checkKind: c.checkKind, status: c.status, detail: c.detail, createdAt: c.createdAt.toISOString() })),
      publications: this.toPlacements(bundle.publications, bundle.revisions),
    };
  }

  // ─── §13.2 legacy brief-family review tool ─────────────────────────

  /**
   * Manually reunites two brief families an operator recognizes as one
   * lineage (e.g. two legacy rows that were really the same brief before
   * P08's fix, isolated by the safe no-op migration). Reassigns every
   * version in `fromFamilyId` into `intoFamilyId`, renumbered to continue
   * after `intoFamilyId`'s current max version, oldest first — never
   * auto-run, never based on a title match.
   */
  async mergeBriefFamilies(projectId: string, fromFamilyId: string, intoFamilyId: string): Promise<{ mergedVersions: number; briefFamilyId: string }> {
    if (fromFamilyId === intoFamilyId) throw new ForbiddenException('Cannot merge a brief family into itself');
    const [fromRows, intoMax] = await Promise.all([
      this.prisma.contentBrief.findMany({ where: { projectId, briefFamilyId: fromFamilyId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.contentBrief.findFirst({ where: { projectId, briefFamilyId: intoFamilyId }, orderBy: { version: 'desc' }, select: { version: true } }),
    ]);
    if (fromRows.length === 0) throw new NotFoundException(`Brief family ${fromFamilyId} not found for project ${projectId}`);
    if (!intoMax) throw new NotFoundException(`Brief family ${intoFamilyId} not found for project ${projectId}`);

    let nextVersion = intoMax.version + 1;
    await this.prisma.$transaction(
      fromRows.map((row) =>
        this.prisma.contentBrief.update({
          where: { id: row.id },
          data: { briefFamilyId: intoFamilyId, version: nextVersion++ },
        }),
      ),
    );
    return { mergedVersions: fromRows.length, briefFamilyId: intoFamilyId };
  }

  // ─── §13.5/§14.4 explicit client sharing ───────────────────────────

  async shareRevision(projectId: string, assetId: string, revisionId: string, userId: string | undefined): Promise<{ shared: boolean; revisionId: string }> {
    await this.assertRevisionBelongs(projectId, assetId, revisionId);
    await this.prisma.contentRevision.update({
      where: { id: revisionId },
      data: { clientVisible: true, clientVisibleAt: new Date(), clientVisibleBy: userId ?? null },
    });
    return { shared: true, revisionId };
  }

  async unshareRevision(projectId: string, assetId: string, revisionId: string): Promise<{ shared: boolean; revisionId: string }> {
    await this.assertRevisionBelongs(projectId, assetId, revisionId);
    await this.prisma.contentRevision.update({
      where: { id: revisionId },
      data: { clientVisible: false, clientVisibleAt: null, clientVisibleBy: null },
    });
    return { shared: false, revisionId };
  }

  private async assertRevisionBelongs(projectId: string, assetId: string, revisionId: string): Promise<void> {
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== projectId) throw new NotFoundException(`Content ${assetId} not found for project ${projectId}`);
    const revision = await this.prisma.contentRevision.findUnique({ where: { id: revisionId } });
    if (!revision || revision.assetId !== assetId) throw new NotFoundException(`Revision ${revisionId} not found for content ${assetId}`);
  }

  async setAssignee(projectId: string, assetId: string, assigneeId: string | null | undefined): Promise<ContentWorkspaceItemDto> {
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== projectId) throw new NotFoundException(`Content ${assetId} not found for project ${projectId}`);
    if (assigneeId) {
      const user = await this.prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true } });
      if (!user) throw new NotFoundException(`User ${assigneeId} not found`);
    }
    await this.prisma.growthAsset.update({ where: { id: assetId }, data: { assigneeId: assigneeId ?? null } });
    const bundle = await this.loadBundle(projectId, assetId);
    return this.toItemDto(bundle!);
  }

  // ─── §13.5/§14.4 client-safe read (called by client-portal.service.ts) ──

  /**
   * The explicitly-shared revision only — NEVER the latest internal draft,
   * NEVER inferred from approval status alone. Returns null when nothing
   * has ever been shared (the caller 404s rather than showing an empty
   * shell, so "no content yet" and "not shared with you" are never
   * confused with each other by a client reading the response).
   */
  async getClientSafeItem(
    projectId: string,
    assetId: string,
  ): Promise<{
    assetId: string;
    title: string;
    assetType: string;
    clientReviewState: ClientReviewState;
    revision: { revision: number; title: string | null; body: string | null; fields: Record<string, unknown>; sharedAt: string | null };
    history: Array<{ revision: number; sharedAt: string | null }>;
    approvalStatus: string | null;
  } | null> {
    const bundle = await this.loadBundle(projectId, assetId);
    if (!bundle) return null;
    const shared = bundle.revisions.filter((r) => r.clientVisible).sort((a, b) => b.revision - a.revision);
    if (shared.length === 0) return null;
    const current = shared[0];

    // Client-facing approval: the newest client-reviewer ApprovalRequest
    // pointed at THIS shared revision specifically (never a staff-internal
    // one, never provider/prompt metadata).
    const clientApproval = bundle.approvals.find((a) => a.reviewerType === 'client' && a.revisionId === current.id);

    return {
      assetId: bundle.asset.id,
      title: bundle.asset.title,
      assetType: bundle.asset.assetType,
      clientReviewState: this.deriveClientReviewState(bundle, current),
      revision: {
        revision: current.revision,
        title: current.title,
        body: current.body,
        fields: parseJson<Record<string, unknown>>(current.fields, {}),
        sharedAt: current.clientVisibleAt ? current.clientVisibleAt.toISOString() : null,
      },
      history: shared.map((r) => ({ revision: r.revision, sharedAt: r.clientVisibleAt ? r.clientVisibleAt.toISOString() : null })),
      approvalStatus: clientApproval ? clientApproval.status : null,
    };
  }

  /**
   * The client-portal list (§13.5 exit gate: clients cannot read unshared
   * drafts). Only pieces with at least one `clientVisible` revision appear
   * at all — an unshared draft is not merely hidden client-side, it is
   * never included in the response.
   */
  async listClientSafeItems(
    projectId: string,
  ): Promise<Array<{ assetId: string; title: string; assetType: string; clientReviewState: ClientReviewState; publicationStatus: PublicationSummaryState; updatedAt: string }>> {
    const bundles = await this.loadBundles(projectId);
    const shared = bundles.filter((b) => b.revisions.some((r) => r.clientVisible));
    return shared.map((b) => {
      const currentShared = b.revisions.filter((r) => r.clientVisible).sort((a, c) => c.revision - a.revision)[0] ?? null;
      return {
        assetId: b.asset.id,
        title: b.asset.title,
        assetType: b.asset.assetType,
        clientReviewState: this.deriveClientReviewState(b, currentShared),
        publicationStatus: this.derivePublicationSummary(b).status,
        updatedAt: b.asset.updatedAt.toISOString(),
      };
    });
  }

  // ─── Internals: batched loads ───────────────────────────────────────

  private async loadBundles(projectId: string): Promise<Bundle[]> {
    const assets = await this.prisma.growthAsset.findMany({
      where: { projectId, assetType: { in: [...CONTENT_WORKSPACE_ASSET_TYPES] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (assets.length === 0) return [];
    const assetIds = assets.map((a) => a.id);

    const [revisions, approvals, publications] = await Promise.all([
      this.prisma.contentRevision.findMany({ where: { assetId: { in: assetIds } }, orderBy: { revision: 'desc' } }),
      this.prisma.approvalRequest.findMany({ where: { projectId, artifactType: 'content', artifactId: { in: assetIds } }, orderBy: { updatedAt: 'desc' } }),
      this.prisma.publication.findMany({ where: { projectId, assetId: { in: assetIds } }, orderBy: { updatedAt: 'desc' } }),
    ]);

    const briefIds = [...new Set(revisions.map((r) => r.briefId).filter((v): v is string => !!v))];
    const briefs = briefIds.length ? await this.prisma.contentBrief.findMany({ where: { id: { in: briefIds } } }) : [];
    const briefById = new Map(briefs.map((b) => [b.id, b]));

    const revisionsByAsset = new Map<string, RevisionRow[]>();
    for (const r of revisions) {
      const list = revisionsByAsset.get(r.assetId) ?? [];
      list.push(r);
      revisionsByAsset.set(r.assetId, list);
    }
    const approvalsByAsset = new Map<string, ApprovalRow[]>();
    for (const a of approvals) {
      const list = approvalsByAsset.get(a.artifactId) ?? [];
      list.push(a);
      approvalsByAsset.set(a.artifactId, list);
    }
    const publicationsByAsset = new Map<string, PublicationRow[]>();
    for (const p of publications) {
      const list = publicationsByAsset.get(p.assetId) ?? [];
      list.push(p);
      publicationsByAsset.set(p.assetId, list);
    }

    return assets.map((asset) => {
      const assetRevisions = revisionsByAsset.get(asset.id) ?? [];
      const latestRevision = assetRevisions[0] ?? null;
      const clientVisibleRevisions = assetRevisions.filter((r) => r.clientVisible).sort((a, b) => b.revision - a.revision);
      return {
        asset,
        revisions: assetRevisions,
        latestRevision,
        latestClientVisible: clientVisibleRevisions[0] ?? null,
        approvals: approvalsByAsset.get(asset.id) ?? [],
        publications: publicationsByAsset.get(asset.id) ?? [],
        brief: latestRevision?.briefId ? (briefById.get(latestRevision.briefId) ?? null) : null,
      };
    });
  }

  private async loadBundle(projectId: string, assetId: string): Promise<Bundle | null> {
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== projectId) return null;
    if (!isContentAssetType(asset.assetType)) {
      // Not a workspace-tracked "content" type — §13.9 excludes it from
      // this workspace, not just from counts, so its detail lives elsewhere.
      return null;
    }

    const [revisions, approvals, publications] = await Promise.all([
      this.prisma.contentRevision.findMany({ where: { assetId }, orderBy: { revision: 'desc' } }),
      this.prisma.approvalRequest.findMany({ where: { projectId, artifactType: 'content', artifactId: assetId }, orderBy: { updatedAt: 'desc' } }),
      this.prisma.publication.findMany({ where: { projectId, assetId }, orderBy: { updatedAt: 'desc' } }),
    ]);
    const latestRevision = revisions[0] ?? null;
    const brief = latestRevision?.briefId ? await this.prisma.contentBrief.findUnique({ where: { id: latestRevision.briefId } }) : null;
    const clientVisibleRevisions = revisions.filter((r) => r.clientVisible).sort((a, b) => b.revision - a.revision);

    return { asset, revisions, latestRevision, latestClientVisible: clientVisibleRevisions[0] ?? null, approvals, publications, brief: brief ?? null };
  }

  // ─── Internals: derivation (§13.4) ──────────────────────────────────

  private toItemDto(b: Bundle): ContentWorkspaceItemDto {
    const editorialState = this.deriveEditorialState(b);
    const clientReviewState = this.deriveClientReviewState(b, b.latestClientVisible);
    const publicationSummary = this.derivePublicationSummary(b);
    const updateState = this.deriveUpdateState(b, publicationSummary);
    const source = b.asset.sourceOpportunityId ? 'opportunity' : b.asset.sourceGapId ? 'gap' : 'manual';

    return {
      assetId: b.asset.id,
      projectId: b.asset.projectId,
      assetType: b.asset.assetType as ContentWorkspaceAssetType,
      title: b.asset.title,
      source,
      sourceGapId: b.asset.sourceGapId,
      sourceOpportunityId: b.asset.sourceOpportunityId,
      market: null,
      language: b.brief?.language ?? null,
      assigneeId: b.asset.assigneeId,
      editorialState,
      clientReviewState,
      publicationSummary,
      updateState,
      primaryBadge: derivePrimaryBadge(editorialState, clientReviewState, publicationSummary, updateState),
      currentVersion: b.latestRevision?.revision ?? 0,
      hasRevision: !!b.latestRevision,
      promotedFromOpportunityId: b.asset.sourceOpportunityId,
      briefFamilyId: b.brief?.briefFamilyId ?? null,
      nextAction: deriveNextAction(editorialState, clientReviewState, updateState),
      createdAt: b.asset.createdAt.toISOString(),
      updatedAt: b.asset.updatedAt.toISOString(),
    };
  }

  private deriveEditorialState(b: Bundle): EditorialState {
    if (!b.latestRevision) return 'planned';

    const latestApproval = b.approvals.find((a) => a.revisionId === b.latestRevision!.id) ?? b.approvals[0];
    if (latestApproval) {
      if (latestApproval.status === 'changes-requested') return 'changes-requested';
      if (latestApproval.status === 'approved' && latestApproval.revisionId === b.latestRevision.id) return 'approved';
      if (latestApproval.status === 'pending') {
        return latestApproval.reviewerType === 'client' ? 'ready-for-client' : 'internal-review';
      }
    }
    return 'draft';
  }

  private deriveClientReviewState(b: Bundle, currentShared: RevisionRow | null): ClientReviewState {
    if (!currentShared) return 'not-shared';
    const clientApprovals = b.approvals.filter((a) => a.reviewerType === 'client');
    const forCurrent = clientApprovals.find((a) => a.revisionId === currentShared.id);
    if (forCurrent) {
      if (forCurrent.status === 'approved') return 'approved';
      if (forCurrent.status === 'changes-requested') return 'changes-requested';
      if (forCurrent.status === 'pending') return 'awaiting-review';
      if (forCurrent.status === 'invalidated' || forCurrent.status === 'cancelled') return 'expired-superseded';
    }
    // Shared, but no client approval request has ever targeted this exact
    // revision — still meaningfully "awaiting review" from the client's POV.
    return 'awaiting-review';
  }

  private derivePublicationSummary(b: Bundle): PublicationSummaryDto {
    const counts: Record<string, number> = {};
    for (const p of b.publications) counts[p.status] = (counts[p.status] ?? 0) + 1;

    let status: PublicationSummaryState = 'unscheduled';
    if (b.publications.length > 0) {
      if (counts['published']) status = 'published';
      else if (counts['publishing']) status = 'publishing';
      else if (counts['failed']) status = 'failed';
      else {
        const scheduled = b.publications.find((p) => p.status === 'pending' && p.scheduledFor);
        status = scheduled ? 'scheduled' : 'planned';
      }
    }

    return { status, counts, placements: this.toPlacements(b.publications, b.revisions) };
  }

  private toPlacements(publications: PublicationRow[], revisions: RevisionRow[]): PlacementSummaryDto[] {
    const revisionById = new Map(revisions.map((r) => [r.id, r]));
    return publications.map((p) => ({
      id: p.id,
      destinationId: p.destinationId,
      provider: '', // resolved by the caller if needed; keeping this read free of an extra join per placement
      status: p.status,
      mode: p.mode,
      scheduledFor: p.scheduledFor ? p.scheduledFor.toISOString() : null,
      remoteUrl: p.remoteUrl,
      revisionId: p.revisionId,
      revisionNumber: revisionById.get(p.revisionId)?.revision ?? null,
    }));
  }

  private deriveUpdateState(b: Bundle, pub: PublicationSummaryDto): UpdateState {
    if (!b.latestRevision) return 'no-update';
    // A previous (older) revision is live published, and the CURRENT
    // revision is not itself the one that published — §13.4: "Published"
    // must not vanish from the response while a new draft is in progress.
    const publishedForOlder = b.publications.some((p) => p.status === 'published' && p.revisionId !== b.latestRevision!.id);
    if (publishedForOlder && pub.status !== 'unscheduled') return 'revision-in-progress';
    return 'no-update';
  }

  private async ensureProject(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }
}

/**
 * Documented UI badge-precedence function (§13.4). Exported so the frontend
 * can reuse the exact same rule rather than re-deriving it — "Published ·
 * Update in progress" must never silently regress to "Draft" and imply the
 * live piece vanished.
 */
export function derivePrimaryBadge(
  editorialState: EditorialState,
  clientReviewState: ClientReviewState,
  publicationSummary: PublicationSummaryDto,
  updateState: UpdateState,
): string {
  const updateSuffix = updateState === 'revision-in-progress' ? ' · Update in progress' : '';

  if (publicationSummary.status === 'published') return `Published${updateSuffix}`;
  if (publicationSummary.status === 'publishing') return `Publishing${updateSuffix}`;
  if (publicationSummary.status === 'failed') return `Publish failed${updateSuffix}`;
  if (publicationSummary.status === 'scheduled') return `Scheduled${updateSuffix}`;

  if (clientReviewState === 'approved') return 'Approved · ready to publish';
  if (clientReviewState === 'changes-requested') return 'Changes requested (client)';
  if (clientReviewState === 'awaiting-review') return 'Awaiting client review';

  if (editorialState === 'changes-requested') return 'Changes requested';
  if (editorialState === 'internal-review') return 'In internal review';
  if (editorialState === 'ready-for-client') return 'Ready for client';
  if (editorialState === 'approved') return 'Approved';
  if (editorialState === 'draft' || editorialState === 'drafting') return 'Draft';
  return 'Planned';
}

function deriveNextAction(editorialState: EditorialState, clientReviewState: ClientReviewState, updateState: UpdateState): string {
  if (updateState === 'revision-in-progress') return 'Finish and review the in-progress update';
  if (editorialState === 'planned') return 'Prepare a draft from this brief';
  if (editorialState === 'draft' || editorialState === 'drafting') return 'Send for internal review';
  if (editorialState === 'internal-review') return 'Complete internal review';
  if (editorialState === 'changes-requested') return 'Address requested changes';
  if (clientReviewState === 'awaiting-review') return 'Waiting on client review';
  if (clientReviewState === 'changes-requested') return 'Address client-requested changes';
  if (editorialState === 'approved' || clientReviewState === 'approved') return 'Schedule or publish';
  return 'Review next step';
}
