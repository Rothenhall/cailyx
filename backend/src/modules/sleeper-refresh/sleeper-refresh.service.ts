/**
 * Sleeper Refresh Service — declining pages worth refreshing (SOP-10).
 *
 * Traffic evidence arrives via manual entry or pasted GSC CSV export (the GSC
 * OAuth integration is an explicit external prerequisite — see
 * docs/analysis/wave-4.md §3). The service derives sleeper status from the
 * provided numbers and tracks the refresh lifecycle, including verifying that
 * `dateModified` actually moved after the refresh shipped.
 *
 * @module sleeper-refresh.service
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/**
 * Sleeper thresholds (SOP-10): a page is a sleeper when traffic declined
 * meaningfully while backlinks (referring domains) are still meaningful.
 * Defaults, overridable per call via filter params.
 */
const DEFAULT_DECLINE_PCT = 20;
const DEFAULT_MIN_REFERRING = 3;

const STATUSES = ['flagged', 'brief-sent', 'in-progress', 'refreshed', 'abandoned'] as const;

@Injectable()
export class SleeperRefreshService {
  constructor(private readonly prisma: PrismaService) {}

  /** Record a candidate sleeper page (manual entry or CSV-import helper). */
  async createPage(
    projectId: string,
    url: string,
    opts: { label?: string; trafficDeclinePct?: number; referringDomains?: number; notes?: string },
  ) {
    await this.assertProject(projectId);
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('URL must start with http(s)://');
    return this.prisma.sleeperPage.create({
      data: {
        projectId,
        url,
        label: opts.label || null,
        trafficDeclinePct: opts.trafficDeclinePct ?? null,
        referringDomains: opts.referringDomains ?? null,
        notes: opts.notes || null,
        // A page with real evidence on file is introspectable from birth;
        // bare entries start flagged like any candidate but score as "unproven".
        status: 'flagged',
      },
    });
  }

  /**
   * Paste a GSC CSV export (pages × clicks over two periods, or arbitrary
   * per-page rows with urls + click changes). Accepted flexible shape per line:
   *   url, declinePct, referringDomains   (CSV/TSV — declinePct optional)
   * or JSON array via {pages:[...]}. Lines that don't parse are counted skipped.
   */
  async importPages(projectId: string, text?: string, pages?: Array<{ url: string; trafficDeclinePct?: number; referringDomains?: number }>) {
    await this.assertProject(projectId);
    const rows: Array<{ url: string; trafficDeclinePct?: number; referringDomains?: number }> = [];
    let skipped = 0;

    if (pages && Array.isArray(pages)) {
      for (const p of pages) {
        if (p && typeof p.url === 'string' && /^https?:\/\//i.test(p.url)) rows.push(p);
        else skipped += 1;
      }
    }
    if (text) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.toLowerCase().includes('clicks')) continue; // header row
        const cols = trimmed.split(/[,\t]/).map((c) => c.trim());
        const url = cols.find((c) => /^https?:\/\//i.test(c));
        if (!url) {
          skipped += 1;
          continue;
        }
        const numbers = cols.slice(1).map((c) => Number(c.replace(/%|\s/g, ''))).filter((n) => !Number.isNaN(n));
        const decline = numbers.find((n) => n !== 0) ?? numbers[0];
        // Optional second numeric column = referring-domain count (per the documented format).
        const other = numbers.filter((n) => n !== decline);
        const referring = other.length > 0 ? other[other.length - 1] : undefined;
        rows.push({
          url,
          trafficDeclinePct: Number.isFinite(decline) ? decline : undefined,
          ...(referring !== undefined ? { referringDomains: referring } : {}),
        });
      }
    }

    if (rows.length === 0) {
      throw new BadRequestException('No importable pages — provide pages:[{url,trafficDeclinePct,referringDomains}] or a CSV/TSV text with at least one column starting with http(s)://');
    }

    const created: Array<{ id: string; url: string; trafficDeclinePct: number | null; referringDomains: number | null; status: string }> = [];
    for (const r of rows.slice(0, 500)) {
      const existing = await this.prisma.sleeperPage.findFirst({ where: { projectId, url: r.url } });
      if (existing) {
        const updated = await this.prisma.sleeperPage.update({
          where: { id: existing.id },
          data: {
            ...(r.trafficDeclinePct !== undefined ? { trafficDeclinePct: r.trafficDeclinePct } : {}),
            ...(r.referringDomains !== undefined ? { referringDomains: r.referringDomains } : {}),
          },
        });
        created.push(updated);
      } else {
        created.push(
          await this.prisma.sleeperPage.create({
            data: {
              projectId,
              url: r.url,
              label: null,
              trafficDeclinePct: r.trafficDeclinePct ?? null,
              referringDomains: r.referringDomains ?? null,
              status: 'flagged',
            },
          }),
        );
      }
    }
    return { upserted: created.length, skipped };
  }

  /**
   * Candidate list (SOP-10 sort): pages meeting the decline + referring-domain
   * thresholds first, ordered by decline; unproven (no numbers) pages after.
   */
  async listPages(
    projectId: string,
    opts: { minDeclinePct?: number; minReferringDomains?: number; status?: string } = {},
  ) {
    const minDecline = opts.minDeclinePct ?? DEFAULT_DECLINE_PCT;
    const minRef = opts.minReferringDomains ?? DEFAULT_MIN_REFERRING;
    const pages = await this.prisma.sleeperPage.findMany({
      where: { projectId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: 'desc' },
    });

    return pages.map((p) => {
      const isSleeper =
        (p.trafficDeclinePct ?? 0) >= minDecline && (p.referringDomains ?? minRef) >= minRef;
      return {
        ...p,
        sleeperStatus: p.trafficDeclinePct === null && p.referringDomains === null ? 'unproven' : isSleeper ? 'sleeper' : 'not-sleeper',
      };
    }).sort((a, b) => (b.trafficDeclinePct ?? -1) - (a.trafficDeclinePct ?? -1));
  }

  /** Update one page (status transitions, evidence numbers, notes). */
  async updatePage(
    projectId: string,
    pageId: string,
    patch: { status?: string; label?: string; trafficDeclinePct?: number; referringDomains?: number; notes?: string; dateModifiedBefore?: string },
  ) {
    const page = await this.assertPage(projectId, pageId);
    if (patch.status && !(STATUSES as readonly string[]).includes(patch.status)) {
      throw new BadRequestException('status must be one of: ' + STATUSES.join(' | '));
    }
    return this.prisma.sleeperPage.update({
      where: { id: page.id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.label !== undefined ? { label: patch.label || null } : {}),
        ...(patch.trafficDeclinePct !== undefined ? { trafficDeclinePct: patch.trafficDeclinePct } : {}),
        ...(patch.referringDomains !== undefined ? { referringDomains: patch.referringDomains } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
        ...(patch.dateModifiedBefore !== undefined ? { dateModifiedBefore: patch.dateModifiedBefore || null } : {}),
        ...(patch.status === 'refreshed' ? { refreshedAt: new Date() } : {}),
      },
    });
  }

  /**
   * Mark a refresh shipped: records the new visible dateModified so the SLA
   * ("the refresh actually moved the page") is auditable.
   */
  async markRefreshed(projectId: string, pageId: string, dateModifiedAfter: string, notes?: string) {
    const page = await this.assertPage(projectId, pageId);
    return this.prisma.sleeperPage.update({
      where: { id: page.id },
      data: {
        status: 'refreshed',
        dateModifiedAfter: dateModifiedAfter || null,
        refreshedAt: new Date(),
        ...(notes !== undefined ? { notes: notes || null } : {}),
      },
    });
  }

  async deletePage(projectId: string, pageId: string) {
    const page = await this.assertPage(projectId, pageId);
    await this.prisma.sleeperPage.delete({ where: { id: page.id } });
    return { deleted: true };
  }

  /** Simple SLA roll-up: how many flagged vs refreshed, and how many shipped refreshes verified dateModified movement. */
  async summary(projectId: string) {
    await this.assertProject(projectId);
    const pages = await this.prisma.sleeperPage.findMany({ where: { projectId } });
    const byStatus: Record<string, number> = {};
    for (const p of pages) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    const dateModifiedMoved = pages.filter((p) => p.status === 'refreshed' && p.dateModifiedAfter && p.dateModifiedAfter !== p.dateModifiedBefore).length;
    return {
      total: pages.length,
      byStatus,
      refreshed: byStatus.refreshed ?? 0,
      dateModifiedMoved,
    };
  }

  // ─── Privates ──────────────────────────────────────────────────

  private async assertProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
  }

  private async assertPage(projectId: string, pageId: string) {
    const page = await this.prisma.sleeperPage.findUnique({ where: { id: pageId } });
    if (!page || page.projectId !== projectId) {
      throw new NotFoundException('Sleeper page not found in this project: ' + pageId);
    }
    return page;
  }
}