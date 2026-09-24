/**
 * Progress Service — one reviewed progress page per completed AEO audit.
 *
 * Joins the two halves the platform already records but never connected:
 * the comparable audit series (what moved) and the delivery plan's verified,
 * client-visible work (what the team did, and when). The deterministic
 * ledger is built first; the page is written only from it; an operator
 * approves it before any client sees it.
 *
 * Generation is best-effort by design — it runs after an audit completes and
 * must never fail that audit. Reads for a report tolerate a missing table so
 * a deploy that outran its SQL degrades to "no progress page", not a 500.
 *
 * @module progress.service
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ProgressReview } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AeoLlmService } from '../aeo-audit/aeo-llm.service';
import { auditComparabilityKey } from '../aeo-audit/aeo-comparability';
import type { AeoVerdict } from '../aeo-audit/aeo-audit.types';
import { buildProgressLedger, type LedgerAudit } from './progress-ledger';
import { storyRequest, templateStory, validateStory } from './progress-story';
import { toReportSection } from './progress-section';
import { parseTargets } from './progress-targets';
import type {
  ProgressLedger,
  ProgressReviewDto,
  ProgressReviewStatus,
  ProgressStory,
  ProgressTarget,
  ReportProgressSection,
  WorkEvidence,
} from './progress.types';

/** Gap source types that name a rival in their sourceId (`${auditId}:${name}`). */
const COMPETITOR_GAP_TYPES = new Set(['aeo-risk', 'market-competitor-risk']);

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: AeoLlmService,
  ) {}

  // ─── Generation ───────────────────────────────────────────────

  /**
   * Build (or rebuild) the review for one completed audit.
   *
   * @param opts.preserveReviewed Leave a review an operator already approved
   *   or rejected untouched — used by automatic refreshes, so neither an
   *   approval nor a rejection (and its reason) is ever silently undone. An
   *   explicit operator regenerate passes false and resets it to draft.
   */
  async generateForAudit(auditId: string, opts: { preserveReviewed?: boolean } = {}): Promise<ProgressReviewDto> {
    const audit = await this.prisma.aeoAudit.findUnique({ where: { id: auditId } });
    if (!audit) throw new NotFoundException('Audit not found: ' + auditId);
    if (audit.status !== 'completed' || !audit.verdict || !audit.finishedAt) {
      throw new BadRequestException('Audit ' + auditId + ' has not completed yet');
    }

    const existing = await this.prisma.progressReview.findUnique({ where: { auditId } });
    if (existing && (existing.status === 'approved' || existing.status === 'rejected') && opts.preserveReviewed) {
      return this.toDto(existing);
    }

    const base = {
      projectId: audit.projectId,
      auditId,
      auditFinishedAt: audit.finishedAt,
    };

    const key = auditComparabilityKey(audit);
    if (!key) return this.saveNotApplicable(base, 'This audit has no recorded question set, so it cannot be compared.');

    const history = await this.prisma.aeoAudit.findMany({
      where: { projectId: audit.projectId, status: 'completed', finishedAt: { lte: audit.finishedAt } },
      orderBy: { finishedAt: 'asc' },
      select: { id: true, startedAt: true, finishedAt: true, verdict: true, querySetId: true, surfaces: true, markets: true },
    });
    const comparable: LedgerAudit[] = history
      .filter((a) => a.finishedAt && auditComparabilityKey(a) === key)
      .flatMap((a) => {
        const verdict = this.parseVerdict(a.verdict);
        return verdict ? [{ id: a.id, startedAt: a.startedAt, finishedAt: a.finishedAt!, verdict }] : [];
      });

    if (comparable.length < 2) {
      const reason =
        history.length <= 1
          ? 'First audit for this project — it becomes the baseline later audits are compared against.'
          : 'No earlier audit asked the same questions on the same engines and markets, so there is nothing comparable yet.';
      return this.saveNotApplicable(base, reason, { baselineAuditId: comparable[0]?.id ?? auditId });
    }

    const baseline = comparable[0];
    const work = await this.loadWork(audit.projectId, baseline.finishedAt, audit.startedAt ?? audit.finishedAt);
    const ledger = buildProgressLedger({
      projectId: audit.projectId,
      comparabilityKey: key,
      audits: comparable,
      markets: this.parseList(audit.markets),
      work,
    });

    const reviewFields = {
      previousAuditId: ledger.previousAuditId,
      baselineAuditId: ledger.baselineAuditId,
      layout: ledger.layout,
      ledger: JSON.stringify(ledger),
    };

    if (!ledger.realProgress) {
      return this.saveNotApplicable(
        base,
        'No change since the comparable audits cleared the materiality floor, so there is no progress page to show.',
        reviewFields,
      );
    }

    const { story, source, model, costUsd } = await this.writeStory(ledger);
    const row = await this.prisma.progressReview.upsert({
      where: { auditId },
      create: { ...base, ...reviewFields, status: 'draft', story: JSON.stringify(story), storySource: source, model, costUsd },
      update: {
        ...reviewFields,
        status: 'draft',
        reason: null,
        story: JSON.stringify(story),
        storySource: source,
        model,
        costUsd,
        generatedAt: new Date(),
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });
    this.logger.log(`Progress review ${row.id} for audit ${auditId}: ${ledger.movements.length} changes, ${ledger.links.length} links, story=${source}`);
    return this.toDto(row);
  }

  private async writeStory(ledger: ProgressLedger): Promise<{ story: ProgressStory; source: 'llm' | 'template'; model: string | null; costUsd: number }> {
    if (!this.llm.isAvailable()) return { story: templateStory(ledger), source: 'template', model: null, costUsd: 0 };
    try {
      const result = await this.llm.json(storyRequest(ledger), (raw) => validateStory(raw, ledger));
      return { story: result.data, source: 'llm', model: result.model, costUsd: result.costUsd };
    } catch (err) {
      // A rejected or failed generation costs polish, never accuracy: the
      // template writes the same facts deterministically.
      this.logger.warn(`Progress story fell back to template: ${(err as Error).message}`);
      return { story: templateStory(ledger), source: 'template', model: null, costUsd: 0 };
    }
  }

  private async saveNotApplicable(
    base: { projectId: string; auditId: string; auditFinishedAt: Date },
    reason: string,
    extra: { previousAuditId?: string; baselineAuditId?: string; layout?: string; ledger?: string } = {},
  ): Promise<ProgressReviewDto> {
    const row = await this.prisma.progressReview.upsert({
      where: { auditId: base.auditId },
      create: { ...base, ...extra, status: 'not-applicable', reason },
      update: {
        ...extra,
        status: 'not-applicable',
        reason,
        story: null,
        storySource: null,
        model: null,
        costUsd: 0,
        generatedAt: new Date(),
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });
    return this.toDto(row);
  }

  // ─── Work evidence (client-visible only) ──────────────────────

  /** Work finished after `after` and no later than `until`: verified work items, live publications, met milestones. */
  private async loadWork(projectId: string, after: Date, until: Date): Promise<WorkEvidence[]> {
    const inWindow = (d: Date | null | undefined): d is Date => !!d && d > after && d <= until;
    const out: WorkEvidence[] = [];

    const items = await this.prisma.workItem.findMany({
      where: { projectId, status: 'verified', clientVisible: true },
      select: { id: true, title: true, discipline: true, targets: true, sourceId: true },
    });
    if (items.length > 0) {
      const verifications = await this.prisma.verification.findMany({
        where: { workItemId: { in: items.map((i) => i.id) }, decision: 'accepted' },
        orderBy: { createdAt: 'asc' },
        select: { workItemId: true, observedAt: true, createdAt: true },
      });
      // A re-verify appends a row; the work was done at the *first* acceptance.
      const doneAt = new Map<string, Date>();
      for (const v of verifications) if (!doneAt.has(v.workItemId)) doneAt.set(v.workItemId, v.observedAt ?? v.createdAt);

      const gapIds = items.map((i) => i.sourceId).filter((id): id is string => !!id);
      const gaps = gapIds.length
        ? await this.prisma.gap.findMany({ where: { id: { in: gapIds } }, select: { id: true, sourceType: true, sourceId: true } })
        : [];
      const gapById = new Map(gaps.map((g) => [g.id, g]));

      for (const item of items) {
        const at = doneAt.get(item.id);
        if (!inWindow(at)) continue;
        let targets: ProgressTarget[] = parseTargets(item.targets);
        let targetSource: WorkEvidence['targetSource'] = targets.length ? 'tagged' : 'none';
        const gap = item.sourceId ? gapById.get(item.sourceId) : undefined;
        if (!targets.length && gap && COMPETITOR_GAP_TYPES.has(gap.sourceType)) {
          const name = gap.sourceId.slice(gap.sourceId.lastIndexOf(':') + 1).trim();
          if (name) {
            targets = [{ kind: 'competitor', value: name }];
            targetSource = 'gap';
          }
        }
        out.push({ id: `work:${item.id}`, kind: 'work-item', title: item.title, discipline: item.discipline, completedAt: at.toISOString(), targets, targetSource });
      }
    }

    const pubs = await this.prisma.publication.findMany({
      where: { projectId, status: 'published' },
      select: { id: true, assetId: true, verifiedAt: true, updatedAt: true },
    });
    const livePubs = pubs.filter((p) => inWindow(p.verifiedAt ?? p.updatedAt));
    if (livePubs.length > 0) {
      const assets = await this.prisma.growthAsset.findMany({
        where: { id: { in: [...new Set(livePubs.map((p) => p.assetId))] } },
        select: { id: true, title: true },
      });
      const titleOf = new Map(assets.map((a) => [a.id, a.title]));
      // One asset pushed to several destinations is one piece of work.
      const seen = new Set<string>();
      for (const p of livePubs) {
        if (seen.has(p.assetId)) continue;
        seen.add(p.assetId);
        out.push({
          id: `pub:${p.id}`,
          kind: 'publication',
          title: `Published: ${titleOf.get(p.assetId) ?? 'content piece'}`,
          discipline: 'content',
          completedAt: (p.verifiedAt ?? p.updatedAt).toISOString(),
          targets: [],
          targetSource: 'none',
        });
      }
    }

    const milestones = await this.prisma.milestone.findMany({
      where: { projectId, status: 'met', clientVisible: true },
      select: { id: true, title: true, metAt: true },
    });
    for (const m of milestones) {
      if (!inWindow(m.metAt)) continue;
      out.push({ id: `milestone:${m.id}`, kind: 'milestone', title: m.title, discipline: null, completedAt: m.metAt.toISOString(), targets: [], targetSource: 'none' });
    }

    return out;
  }

  // ─── Review workflow ──────────────────────────────────────────

  async list(projectId: string): Promise<{ reviews: ProgressReviewDto[] }> {
    const rows = await this.prisma.progressReview.findMany({ where: { projectId }, orderBy: { auditFinishedAt: 'desc' } });
    return { reviews: rows.map((r) => this.toDto(r)) };
  }

  async get(projectId: string, reviewId: string): Promise<ProgressReviewDto> {
    return this.toDto(await this.row(projectId, reviewId));
  }

  async approve(projectId: string, reviewId: string, userId: string, note?: string): Promise<ProgressReviewDto> {
    const row = await this.row(projectId, reviewId);
    if (row.status !== 'draft' && row.status !== 'rejected') {
      throw new ConflictException(`Only a draft or rejected review can be approved (this one is ${row.status})`);
    }
    const updated = await this.prisma.progressReview.update({
      where: { id: reviewId },
      data: { status: 'approved', reviewedBy: userId, reviewedAt: new Date(), reviewNote: note ?? null },
    });
    return this.toDto(updated);
  }

  async reject(projectId: string, reviewId: string, userId: string, note: string): Promise<ProgressReviewDto> {
    const row = await this.row(projectId, reviewId);
    if (row.status !== 'draft' && row.status !== 'approved') {
      throw new ConflictException(`Only a draft or approved review can be rejected (this one is ${row.status})`);
    }
    const updated = await this.prisma.progressReview.update({
      where: { id: reviewId },
      data: { status: 'rejected', reviewedBy: userId, reviewedAt: new Date(), reviewNote: note },
    });
    return this.toDto(updated);
  }

  private async row(projectId: string, reviewId: string): Promise<ProgressReview> {
    const row = await this.prisma.progressReview.findUnique({ where: { id: reviewId } });
    // Ownership through the URL's project — a foreign id reads as not found.
    if (!row || row.projectId !== projectId) throw new NotFoundException('Progress review not found: ' + reviewId);
    return row;
  }

  // ─── Report read ──────────────────────────────────────────────

  /**
   * The progress page for a report — the approved review for the **same
   * audit** the report's AEO section shows, or null. Never a review for a
   * different audit, and never a draft.
   *
   * @param aeo The report's AEO snapshot. Null means the report has no AEO
   *   section, so it gets no progress page either. A snapshot carrying
   *   `auditId` is paired exactly; one stored before that field existed falls
   *   back to "latest audit finished before the report was generated".
   */
  async sectionForReport(
    projectId: string,
    reportCreatedAt: Date,
    aeo: { auditId?: string } | null,
  ): Promise<ReportProgressSection | null> {
    if (!aeo) return null;
    try {
      const auditId =
        aeo.auditId ??
        (
          await this.prisma.aeoAudit.findFirst({
            where: { projectId, status: 'completed', finishedAt: { lte: reportCreatedAt } },
            orderBy: { finishedAt: 'desc' },
            select: { id: true },
          })
        )?.id;
      if (!auditId) return null;
      const review = await this.prisma.progressReview.findUnique({ where: { auditId } });
      if (!review || review.projectId !== projectId || review.status !== 'approved') return null;
      const ledger = this.parseJson<ProgressLedger>(review.ledger);
      if (!ledger?.checkpoints?.length) return null;
      return toReportSection(ledger, this.parseJson<ProgressStory>(review.story), review.id, new Date().toISOString());
    } catch (err) {
      this.logger.warn(`Progress section unavailable for ${projectId}: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Mapping ──────────────────────────────────────────────────

  private toDto(row: ProgressReview): ProgressReviewDto {
    const ledger = this.parseJson<ProgressLedger>(row.ledger);
    const story = this.parseJson<ProgressStory>(row.story);
    const hasLedger = !!ledger?.checkpoints?.length;
    return {
      id: row.id,
      projectId: row.projectId,
      auditId: row.auditId,
      auditFinishedAt: row.auditFinishedAt.toISOString(),
      previousAuditId: row.previousAuditId,
      baselineAuditId: row.baselineAuditId,
      status: row.status as ProgressReviewStatus,
      reason: row.reason,
      layout: row.layout === 'extended' ? 'extended' : 'compact',
      ledger: hasLedger ? ledger : null,
      story,
      storySource: row.storySource === 'llm' || row.storySource === 'template' ? row.storySource : null,
      preview: hasLedger && story ? toReportSection(ledger!, story, row.id, row.generatedAt.toISOString()) : null,
      model: row.model,
      costUsd: row.costUsd,
      generatedAt: row.generatedAt.toISOString(),
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
    };
  }

  private parseVerdict(raw: string | null): AeoVerdict | null {
    const v = this.parseJson<AeoVerdict>(raw);
    return v?.counted?.overall ? v : null;
  }

  private parseList(raw: string): string[] {
    const v = this.parseJson<unknown>(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  private parseJson<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
