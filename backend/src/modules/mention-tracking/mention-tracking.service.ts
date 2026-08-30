/**
 * Mention Tracking Service — external mention ledger (SOP-7, FR-4.4).
 *
 * Manual target entry + semi-auto single-fetch mention checks (same low-ToS
 * posture as entity-audit semi-auto verification). Each check appends a
 * MentionCheck row; the decay view derives "not seen in N days" from the check
 * history. Outreach lifecycle lives on the target's status.
 *
 * @module mention-tracking.service
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import type { MentionCheckResult, MentionDecay } from './mention-tracking.types';

/** A mention older than this many days is flagged stale (SOP-7 decay). */
const STALE_DAYS = 90;

@Injectable()
export class MentionTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: FetcherService,
  ) {}

  // ─── Campaigns ─────────────────────────────────────────────────

  async createCampaign(projectId: string, name: string, listicleQuery?: string) {
    await this.assertProject(projectId);
    return this.prisma.mentionCampaign.create({
      data: { projectId, name, listicleQuery: listicleQuery || null },
    });
  }

  async listCampaigns(projectId: string) {
    return this.prisma.mentionCampaign.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { targets: true } } },
    });
  }

  // ─── Targets ───────────────────────────────────────────────────

  /** Record a candidate mention target ("best X" page omitting the client, a review platform, …). */
  async createTarget(
    projectId: string,
    url: string,
    type: string,
    label?: string,
    campaignId?: string,
    notes?: string,
  ) {
    await this.assertProject(projectId);
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('URL must start with http(s)://');
    if (type && !['listicle', 'community', 'review', 'other'].includes(type)) {
      throw new BadRequestException('type must be listicle | community | review | other');
    }
    return this.prisma.mentionTarget.create({
      data: { projectId, url, type: type || 'listicle', label: label || null, campaignId: campaignId || null, notes: notes || null },
    });
  }

  /** Targets with their latest check attached. */
  async listTargets(projectId: string, status?: string) {
    const targets = await this.prisma.mentionTarget.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { checks: { orderBy: { checkedAt: 'desc' }, take: 1 } },
    });
    return targets.map((t) => ({ ...t, latestCheck: t.checks[0] ?? null, checks: undefined }));
  }

  /** Update target label/notes/status (outreach lifecycle). */
  async updateTarget(projectId: string, targetId: string, patch: { label?: string; status?: string; notes?: string }) {
    const target = await this.assertTarget(projectId, targetId);
    if (patch.status && !['new', 'contacted', 'replied', 'placed', 'rejected'].includes(patch.status)) {
      throw new BadRequestException('status must be new | contacted | replied | placed | rejected');
    }
    return this.prisma.mentionTarget.update({
      where: { id: target.id },
      data: {
        ...(patch.label !== undefined ? { label: patch.label || null } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
      },
    });
  }

  async deleteTarget(projectId: string, targetId: string) {
    const target = await this.assertTarget(projectId, targetId);
    await this.prisma.mentionTarget.delete({ where: { id: target.id } });
    return { deleted: true };
  }

  // ─── Checks ────────────────────────────────────────────────────

  /**
   * Run one semi-auto check: fetch the target page ONCE and look for the
   * client brand. History accumulates — decay reads the ledger, and gaps
   * between checks are exactly how staleness is measured.
   */
  async checkTarget(projectId: string, targetId: string, brandToken: string) {
    const target = await this.assertTarget(projectId, targetId);
    if (!brandToken || brandToken.trim().length < 2) {
      throw new BadRequestException('brandToken (the client name to search for) is required (min 2 chars)');
    }

    const check = await this.fetchPage(target.url, brandToken.trim());
    const row = await this.prisma.mentionCheck.create({
      data: {
        targetId: target.id,
        mentioned: check.mentioned,
        evidence: check.evidence,
        fetchedTitle: check.fetchedTitle,
        httpStatus: check.httpStatus,
      },
    });
    return row as unknown as MentionCheckResult & { id: string; checkedAt: Date };
  }

  /** Full check history for one target, newest first. */
  async listChecks(projectId: string, targetId: string) {
    await this.assertTarget(projectId, targetId);
    return this.prisma.mentionCheck.findMany({ where: { targetId }, orderBy: { checkedAt: 'desc' } });
  }

  /**
   * Decay view (SOP-7): for each target, when was it last seen mentioning the
   * client, and is it stale? A target never mentioned yet is simply
   * `everMentioned:false` with no decay — the missing-listicle gap, not decay.
   */
  async decayView(projectId: string, brandToken: string): Promise<MentionDecay[]> {
    await this.assertProject(projectId);
    const token = brandToken.trim().toLowerCase();
    const targets = await this.prisma.mentionTarget.findMany({
      where: { projectId },
      include: { checks: { orderBy: { checkedAt: 'asc' } } },
    });

    const now = Date.now();
    return targets.map((t) => {
      const mentionedChecks = t.checks.filter((c) => c.mentioned && (c.evidence || '').toLowerCase().includes(token));
      const lastMentioned = mentionedChecks[mentionedChecks.length - 1];
      const lastChecked = t.checks[t.checks.length - 1];
      const daysSinceLastMention = lastMentioned
        ? Math.floor((now - new Date(lastMentioned.checkedAt).getTime()) / (24 * 3600 * 1000))
        : null;
      return {
        targetId: t.id,
        url: t.url,
        type: t.type as MentionDecay['type'],
        status: t.status as MentionDecay['status'],
        everMentioned: mentionedChecks.length > 0,
        lastMentionedAt: lastMentioned ? new Date(lastMentioned.checkedAt).toISOString() : null,
        lastCheckedAt: lastChecked ? new Date(lastChecked.checkedAt).toISOString() : null,
        daysSinceLastMention,
        stale: daysSinceLastMention !== null && daysSinceLastMention >= STALE_DAYS,
      };
    });
  }

  // ─── Privates ──────────────────────────────────────────────────

  private async fetchPage(url: string, brandToken: string): Promise<MentionCheckResult> {
    try {
      const result = await this.fetcher.fetch({ url }, 'mention-tracking');
      const httpStatus = result.status;
      if (httpStatus < 200 || httpStatus >= 300 || !result.body) {
        return { mentioned: false, evidence: null, fetchedTitle: null, httpStatus };
      }
      const $ = cheerio.load(result.body);
      const fetchedTitle = $('title').text().trim() || null;
      const text = $('body').text().replace(/\s+/g, ' ');
      const idx = text.toLowerCase().indexOf(brandToken.toLowerCase());
      if (idx === -1) return { mentioned: false, evidence: null, fetchedTitle, httpStatus };
      return {
        mentioned: true,
        evidence: text.slice(Math.max(0, idx - 60), idx + brandToken.length + 60).trim(),
        fetchedTitle,
        httpStatus,
      };
    } catch {
      return { mentioned: false, evidence: null, fetchedTitle: null, httpStatus: null };
    }
  }

  private async assertProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
  }

  private async assertTarget(projectId: string, targetId: string) {
    const target = await this.prisma.mentionTarget.findUnique({ where: { id: targetId } });
    if (!target || target.projectId !== projectId) {
      throw new NotFoundException('Mention target not found in this project: ' + targetId);
    }
    return target;
  }
}