/**
 * Crawler Monitor Service — server-log ingestion of AI-crawler hits (SOP-3/4.5).
 *
 * Accepts structured hits (JSON) or raw common-log-format lines, classifies
 * each against the static bot registry, stores CrawlerHit rows, and produces
 * activity roll-ups (training vs search split, by vendor, top URLs). Also
 * unblocks the deferred hallucinated-404 sweep (needs AI-referral URL data).
 *
 * @module crawler-monitor.service
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BOT_REGISTRY } from './crawler-monitor.types';
import type { BotSignature, BotType, CrawlerSummary, IngestHitInput } from './crawler-monitor.types';

/** Nginx/Apache combined-log-format single line: ip - - [ts] "GET url ..." UA " */
const CLF_PATTERN = /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) (\S+)[^"]*" (\d+) \S+/;

@Injectable()
export class CrawlerMonitorService {
  private readonly logger = new Logger(CrawlerMonitorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ingest hits: JSON hits[] and/or raw combined-log-format text.
   * Nothing silently dropped — unparseable entries are counted and reported.
   * @throws BadRequestException when no hits could be parsed at all.
   */
  async ingest(projectId: string, input: { hits?: IngestHitInput[]; logText?: string }): Promise<{ ingested: number; skipped: number }> {
    const hits: IngestHitInput[] = [];
    let skipped = 0;

    for (const h of input.hits ?? []) {
      if (h.timestamp && h.url && h.userAgent) {
        hits.push(h);
      } else {
        skipped += 1;
      }
    }

    if (input.logText) {
      const parsed = this.parseLogText(input.logText);
      hits.push(...parsed.hits);
      skipped += parsed.skipped;
    }

    if (hits.length === 0) {
      throw new BadRequestException('No parseable hits — provide hits[] (timestamp/url/userAgent) or logText in combined log format');
    }

    await this.prisma.crawlerHit.createMany({
      data: hits.map((h) => {
        const sig = this.classify(h.userAgent);
        return {
          projectId,
          hitAt: new Date(h.timestamp),
          url: h.url,
          userAgent: h.userAgent,
          ipAddress: h.ip ?? null,
          botVendor: sig.vendor,
          botName: sig.name,
          botType: sig.type,
        };
      }),
    });

    this.logger.log('Ingested ' + hits.length + ' crawler hits for project ' + projectId + ' (' + skipped + ' skipped)');
    return { ingested: hits.length, skipped };
  }

  /** Activity roll-up over an optional window (daysBack, default: all time). */
  async summary(projectId: string, daysBack?: number): Promise<CrawlerSummary> {
    const since = daysBack && daysBack > 0 ? new Date(Date.now() - daysBack * 24 * 3600 * 1000) : undefined;
    const hits = await this.prisma.crawlerHit.findMany({
      where: { projectId, ...(since ? { hitAt: { gte: since } } : {}) },
      orderBy: { hitAt: 'desc' },
    });

    const byType: Record<BotType, number> = { training: 0, search: 0, 'citation-engine': 0, unknown: 0 };
    const vendors = new Map<string, { hits: number; byType: Record<string, number> }>();
    const urls = new Map<string, number>();

    for (const h of hits) {
      byType[h.botType as BotType] = (byType[h.botType as BotType] ?? 0) + 1;
      const row = vendors.get(h.botVendor) ?? { hits: 0, byType: {} };
      row.hits += 1;
      row.byType[h.botType] = (row.byType[h.botType] ?? 0) + 1;
      vendors.set(h.botVendor, row);
      urls.set(h.url, (urls.get(h.url) ?? 0) + 1);
    }

    return {
      totalHits: hits.length,
      byType,
      byVendor: [...vendors.entries()]
        .map(([vendor, r]) => ({ vendor, hits: r.hits, byType: r.byType }))
        .sort((a, b) => b.hits - a.hits),
      topUrls: [...urls.entries()]
        .map(([url, count]) => ({ url, hits: count }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 20),
      lastSeen: hits.length > 0 ? hits[0].hitAt.toISOString() : null,
    };
  }

  /** Raw hits, newest first, with pagination. */
  async listHits(projectId: string, limit?: number) {
    return this.prisma.crawlerHit.findMany({
      where: { projectId },
      orderBy: { hitAt: 'desc' },
      take: Math.min(Math.max(limit ?? 100, 1), 1000),
    });
  }

  // ─── Privates ─────────────────────────────────────────────────

  /** Longest registry match wins (GPTBot vs OAI-SearchBot substrings). */
  private classify(userAgent: string): BotSignature {
    const ua = userAgent.toLowerCase();
    let best: BotSignature | null = null;
    for (const sig of BOT_REGISTRY) {
      if (ua.includes(sig.match) && (!best || sig.match.length > best.match.length)) {
        best = sig;
      }
    }
    if (best) return best;
    return { match: '', vendor: 'other', name: userAgent.slice(0, 80), type: 'unknown' };
  }

  /** Parse combined log format; returns hits + skipped count. */
  private parseLogText(text: string): { hits: IngestHitInput[]; skipped: number } {
    const hits: IngestHitInput[] = [];
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const m = trimmed.match(CLF_PATTERN);
      const ua = trimmed.match(/"([^"]*)"[^"]*$/);
      if (!m || !ua || !this.looksLikeBot(ua[1])) {
        skipped += 1;
        continue;
      }
      hits.push({ timestamp: this.parseClfTime(m[2]), url: m[4], userAgent: ua[1], ip: m[1] });
    }
    return { hits, skipped };
  }

  /** Only ingest log lines whose UA matches the registry — human traffic is out of scope. */
  private looksLikeBot(userAgent: string): boolean {
    const ua = userAgent.toLowerCase();
    return BOT_REGISTRY.some((sig) => ua.includes(sig.match));
  }

  /** "10/Oct/2025:13:55:36 -0700" -> ISO string. */
  private parseClfTime(raw: string): string {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const m = raw.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/);
    if (!m) return new Date(raw).toISOString();
    const month = months[m[2].toLowerCase()] ?? '01';
    const offset = m[7] ?? '+0000';
    // Rebuild as a parseable form: YYYY-MM-DDTHH:mm:ss<offset>
    const normalized = m[3] + '-' + month + '-' + m[1] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + (offset ? offset.slice(0, 3) + ':' + offset.slice(3) : 'Z');
    return new Date(normalized).toISOString();
  }
}