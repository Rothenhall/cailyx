/**
 * SEO audit orchestrator.
 *
 * Reads Google Search Console (Search Analytics + URL Inspection + Sitemaps)
 * for a project's mapped property, runs everything through seo-rubric, and
 * persists a run: window metrics + timeseries, per-query rows with movement
 * and opportunity flags, per-URL index status with classified issues, and a
 * grouped "fix these" list where each item carries a concrete fix (and, when
 * possible, a paste-ready artifact or a Cailyx action).
 *
 * @module seo-audit/seo-audit.service
 */

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GoogleConnectionService } from '../google/google-connection.service';
import { SearchConsoleService, type SaRow } from '../google/search-console.service';
import {
  buildFindings,
  buildQueryRows,
  classifyPage,
  scoreAudit,
  type PageIssue,
  type QueryRow,
} from './seo-rubric';

const INSPECT_BUDGET = Number(process.env.SEO_INSPECT_BUDGET || 40);
const INSPECT_CONCURRENCY = 4;

export interface Delta {
  metric: string;
  label: string;
  previous: number | null;
  current: number | null;
  change: number | null;
  direction: 'improved' | 'regressed' | 'unchanged' | 'new';
  higherIsBetter: boolean;
}

@Injectable()
export class SeoAuditService {
  private readonly logger = new Logger(SeoAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: GoogleConnectionService,
    private readonly gsc: SearchConsoleService,
  ) {}

  /* ── window helpers ─────────────────────────────────────────────────── */
  private windows(days: number) {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 2); // GSC lag
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const prevEnd = new Date(start);
    prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return {
      cur: { startDate: iso(start), endDate: iso(end) },
      prev: { startDate: iso(prevStart), endDate: iso(prevEnd) },
    };
  }

  async run(projectId: string, userId: string, triggeredBy: 'manual' | 'scheduled', windowDays = 28) {
    const site = await this.connections.requireProjectResource(projectId, 'search-console');
    const started = Date.now();
    const { cur, prev } = this.windows(windowDays);
    let saCalls = 0;
    let inspectCalls = 0;

    const sa = (body: Parameters<SearchConsoleService['searchAnalytics']>[2]) => {
      saCalls++;
      return this.gsc.searchAnalytics(userId, site, body);
    };

    const [totCur, totPrev, qCur, qPrev, byDate, byPage, sitemaps] = await Promise.all([
      sa({ ...cur, rowLimit: 1 }),
      sa({ ...prev, rowLimit: 1 }),
      sa({ ...cur, dimensions: ['query', 'page'], rowLimit: 250 }),
      sa({ ...prev, dimensions: ['query'], rowLimit: 250 }),
      sa({ ...cur, dimensions: ['date'], rowLimit: 100 }),
      sa({ ...cur, dimensions: ['page'], rowLimit: 200 }),
      this.gsc.listSitemaps(userId, site).catch(() => []),
    ]);

    const t = totCur[0] ?? emptyRow();
    const tp = totPrev[0] ?? null;

    // per-query, collapsing query+page rows into one row per query with a
    // page set (for cannibalisation) and the top page by clicks
    const pagesByQuery = new Map<string, Set<string>>();
    const bestByQuery = new Map<string, SaRow>();
    for (const r of qCur) {
      const q = r.keys[0];
      const pg = r.keys[1];
      if (!pagesByQuery.has(q)) pagesByQuery.set(q, new Set());
      if (pg) pagesByQuery.get(q)!.add(pg);
      const existing = bestByQuery.get(q);
      if (!existing) {
        bestByQuery.set(q, { ...r, keys: [q, pg] });
      } else {
        existing.clicks += r.clicks;
        existing.impressions += r.impressions;
        // keep the higher-click page as topPage, weight position/ctr by impressions
        if (r.clicks > (r.keys[1] === existing.keys[1] ? 0 : existing.clicks)) existing.keys[1] = pg;
      }
    }
    // recompute blended position/ctr per query from the collapsed impressions
    const curQueryRows: SaRow[] = [];
    for (const [q, agg] of bestByQuery) {
      const parts = qCur.filter((r) => r.keys[0] === q);
      const impr = parts.reduce((s, r) => s + r.impressions, 0) || 1;
      const position = parts.reduce((s, r) => s + r.position * r.impressions, 0) / impr;
      const clicks = parts.reduce((s, r) => s + r.clicks, 0);
      const ctr = agg.impressions ? clicks / agg.impressions : 0;
      curQueryRows.push({ keys: agg.keys, clicks, impressions: agg.impressions, ctr, position });
    }

    const queryRows: QueryRow[] = buildQueryRows(curQueryRows, qPrev, pagesByQuery);

    // pages to inspect: by impressions desc, capped
    const pageMetrics = byPage
      .map((r) => ({
        url: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }))
      .filter((p) => p.url)
      .sort((a, b) => b.impressions - a.impressions);

    const toInspect = pageMetrics.slice(0, INSPECT_BUDGET);
    const pageIssues: Array<{ url: string; issues: PageIssue[] }> = [];
    const inspectionByUrl = new Map<string, Awaited<ReturnType<SearchConsoleService['inspectUrl']>>>();

    for (let i = 0; i < toInspect.length; i += INSPECT_CONCURRENCY) {
      const batch = toInspect.slice(i, i + INSPECT_CONCURRENCY);
      await Promise.all(
        batch.map(async (p) => {
          try {
            inspectCalls++;
            const insp = await this.gsc.inspectUrl(userId, site, p.url);
            inspectionByUrl.set(p.url, insp);
            if (insp) pageIssues.push({ url: p.url, issues: classifyPage(p.url, insp) });
          } catch (err) {
            this.logger.warn(`inspect ${p.url} failed: ${(err as Error).message}`);
          }
        }),
      );
    }

    const findings = buildFindings(pageIssues, queryRows, sitemaps);
    const score = scoreAudit(toInspect.length, pageIssues, queryRows);

    // previous run, for the delta chain
    const prevAudit = await this.prisma.seoAudit.findFirst({
      where: { projectId, score: { not: null } },
      orderBy: { createdAt: 'desc' },
    });

    const timeseries = byDate
      .map((r) => ({
        date: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: round(r.position, 1),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const criticalCount = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
    const notIndexed = pageIssues.filter((p) =>
      p.issues.some((i) => i.code.startsWith('not-indexed') || i.code === 'noindex' || i.code === 'blocked-robots'),
    ).length;
    const strikingCount = queryRows.filter((q) => q.opportunities.includes('striking-distance')).length;

    const deltas: Delta[] = prevAudit
      ? this.diff(prevAudit, {
          score,
          clicks: t.clicks,
          impressions: t.impressions,
          ctr: t.ctr,
          position: t.position,
          criticalCount,
          notIndexed,
          strikingCount,
        })
      : [];

    const id = `seo_${Date.now()}`;
    await this.prisma.seoAudit.create({
      data: {
        id,
        projectId,
        siteUrl: site,
        triggeredBy,
        windowDays,
        score,
        previousAuditId: prevAudit?.id ?? null,
        deltas: JSON.stringify(deltas),
        clicks: t.clicks,
        impressions: t.impressions,
        ctr: t.ctr,
        position: round(t.position, 1),
        metrics: JSON.stringify({
          prev: tp ? { clicks: tp.clicks, impressions: tp.impressions, ctr: tp.ctr, position: round(tp.position, 1) } : null,
          timeseries,
        }),
        pagesInspected: toInspect.length,
        observability: JSON.stringify({
          totalLatencyMs: Date.now() - started,
          totalCostUsd: 0,
          saCalls,
          inspectCalls,
        }),
      },
    });

    await this.chunk(queryRows, 25, (rows) =>
      this.prisma.seoQuery.createMany({
        data: rows.map((q) => ({
          auditId: id,
          query: q.query,
          clicks: q.clicks,
          impressions: q.impressions,
          ctr: q.ctr,
          position: q.position,
          positionDelta: q.positionDelta,
          impressionsDelta: q.impressionsDelta,
          clicksDelta: q.clicksDelta,
          topPage: q.topPage,
          opportunities: JSON.stringify(q.opportunities),
        })),
      }),
    );

    await this.chunk(pageMetrics.slice(0, 200), 25, (rows) =>
      this.prisma.seoPage.createMany({
        data: rows.map((p) => {
          const insp = inspectionByUrl.get(p.url);
          const issues = pageIssues.find((x) => x.url === p.url)?.issues ?? [];
          return {
            auditId: id,
            url: p.url,
            clicks: p.clicks,
            impressions: p.impressions,
            ctr: p.ctr,
            position: round(p.position, 1),
            coverageState: insp?.coverageState ?? null,
            indexVerdict: insp?.verdict ?? null,
            indexingState: insp?.indexingState ?? null,
            robotsTxtState: insp?.robotsTxtState ?? null,
            pageFetchState: insp?.pageFetchState ?? null,
            googleCanonical: insp?.googleCanonical ?? null,
            userCanonical: insp?.userCanonical ?? null,
            lastCrawlTime: insp?.lastCrawlTime ? new Date(insp.lastCrawlTime) : null,
            issues: JSON.stringify(issues),
            richResults: JSON.stringify([...new Set((insp?.richResultItems ?? []).map((r) => r.type))]),
            richIssues: JSON.stringify(
              (insp?.richResultItems ?? []).filter((r) => r.issues.length).map((r) => ({ type: r.type, issues: r.issues })),
            ),
          };
        }),
      }),
    );

    await this.chunk(findings, 25, (rows) =>
      this.prisma.seoFinding.createMany({
        data: rows.map((f) => ({
          auditId: id,
          type: f.type,
          status: f.status,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          recommendedFix: f.recommendedFix,
          affected: JSON.stringify(f.affected),
          count: f.affected.length || 1,
          fixArtifact: f.fixArtifact,
          action: f.action,
        })),
      }),
    );

    this.logger.log(
      `SEO audit ${id} for ${site}: score ${score}, ${queryRows.length} queries, ${toInspect.length} URLs inspected, ${findings.length} findings`,
    );
    return this.get(projectId, id);
  }

  /* ── reads ──────────────────────────────────────────────────────────── */

  list(projectId: string) {
    return this.prisma.seoAudit
      .findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: {
          id: true,
          createdAt: true,
          score: true,
          clicks: true,
          impressions: true,
          ctr: true,
          position: true,
          windowDays: true,
          previousAuditId: true,
          triggeredBy: true,
        },
      })
      .then((audits) => ({ audits }));
  }

  async get(projectId: string, auditId: string) {
    const audit = await this.prisma.seoAudit.findFirst({
      where: { id: auditId, projectId },
      include: {
        findings: { orderBy: { severity: 'asc' } },
        queries: { orderBy: { impressions: 'desc' } },
        pages: { orderBy: { impressions: 'desc' } },
      },
    });
    return audit;
  }

  async comparison(projectId: string, auditId: string) {
    const current = await this.prisma.seoAudit.findFirst({ where: { id: auditId, projectId } });
    if (!current) return null;
    const previous = await this.prisma.seoAudit.findFirst({
      where: { projectId, score: { not: null }, createdAt: { lt: current.createdAt } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      currentAuditId: current.id,
      previousAuditId: previous?.id ?? null,
      currentAt: current.createdAt.toISOString(),
      previousAt: previous?.createdAt.toISOString() ?? null,
      deltas: previous
        ? this.diff(previous, {
            score: current.score ?? 0,
            clicks: current.clicks,
            impressions: current.impressions,
            ctr: current.ctr,
            position: current.position,
            criticalCount: 0,
            notIndexed: 0,
            strikingCount: 0,
          }).filter((d) => d.previous !== null || d.current !== null)
        : [],
    };
  }

  async trend(projectId: string, limit = 30) {
    const rows = await this.prisma.seoAudit.findMany({
      where: { projectId, score: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, createdAt: true, score: true, clicks: true, impressions: true, position: true, triggeredBy: true },
    });
    return {
      history: rows
        .map((r) => ({
          auditId: r.id,
          at: r.createdAt.toISOString(),
          score: r.score,
          clicks: r.clicks,
          impressions: r.impressions,
          position: r.position,
          triggeredBy: r.triggeredBy,
        }))
        .reverse(),
    };
  }

  /** The one thing this audit can *do*: re-submit the property's sitemap(s). */
  async submitSitemaps(projectId: string, userId: string): Promise<{ submitted: string[] }> {
    const site = await this.connections.requireProjectResource(projectId, 'search-console');
    const sitemaps = await this.gsc.listSitemaps(userId, site);
    if (!sitemaps.length) throw new ConflictException('No sitemap is registered for this property in Search Console.');
    const submitted: string[] = [];
    for (const s of sitemaps) {
      try {
        await this.gsc.submitSitemap(userId, site, s.path);
        submitted.push(s.path);
      } catch (err) {
        this.logger.warn(`sitemap submit ${s.path} failed: ${(err as Error).message}`);
      }
    }
    return { submitted };
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  private diff(
    prev: { score: number | null; clicks: number; impressions: number; ctr: number; position: number },
    cur: {
      score: number;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
      criticalCount: number;
      notIndexed: number;
      strikingCount: number;
    },
  ): Delta[] {
    const mk = (metric: string, label: string, p: number | null, c: number | null, higherIsBetter: boolean): Delta => {
      const change = p !== null && c !== null ? round(c - p, 3) : null;
      let direction: Delta['direction'] = 'unchanged';
      if (c === null) direction = 'unchanged';
      else if (p === null) direction = 'new';
      else if (c === p) direction = 'unchanged';
      else direction = c > p === higherIsBetter ? 'improved' : 'regressed';
      return { metric, label, previous: p, current: c, change, direction, higherIsBetter };
    };
    return [
      mk('score', 'SEO score', prev.score, cur.score, true),
      mk('clicks', 'Clicks', prev.clicks, cur.clicks, true),
      mk('impressions', 'Impressions', prev.impressions, cur.impressions, true),
      mk('ctr', 'CTR', round(prev.ctr * 100, 2), round(cur.ctr * 100, 2), true),
      mk('position', 'Avg position', round(prev.position, 1), round(cur.position, 1), false),
      mk('criticalIssues', 'Critical / high issues', null, cur.criticalCount, false),
      mk('notIndexed', 'Pages not indexed', null, cur.notIndexed, false),
      mk('strikingDistance', 'Striking-distance queries', null, cur.strikingCount, false),
    ];
  }

  private async chunk<T>(items: T[], size: number, fn: (batch: T[]) => Promise<unknown>): Promise<void> {
    for (let i = 0; i < items.length; i += size) {
      if (items.length) await fn(items.slice(i, i + size));
    }
  }
}

function emptyRow(): SaRow {
  return { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
}
function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
