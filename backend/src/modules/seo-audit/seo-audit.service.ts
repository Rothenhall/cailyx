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
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import {
  buildFindings,
  buildQueryRows,
  classifyPage,
  normUrl,
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
    private readonly pipelineQueue: PipelineQueueService,
  ) {
    this.pipelineQueue.registerHandler('seo-audit', (data: {
      projectId: string; userId: string; triggeredBy: 'manual' | 'scheduled'; windowDays: number;
    }) => this.run(data.projectId, data.userId, data.triggeredBy, data.windowDays));
  }

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

    // Collapse the query+page rows into one row per query. Distinct *pages*
    // are tracked by a normalised URL (so www / non-www / trailing-slash
    // variants of the same page don't read as cannibalisation), while the
    // topPage kept for display is the real URL with the most clicks.
    const groups = new Map<
      string,
      { pages: Set<string>; topPage: string; topClicks: number; parts: SaRow[] }
    >();
    for (const r of qCur) {
      const q = r.keys[0];
      const pg = r.keys[1] ?? '';
      let g = groups.get(q);
      if (!g) {
        g = { pages: new Set(), topPage: pg, topClicks: -1, parts: [] };
        groups.set(q, g);
      }
      if (pg) g.pages.add(normUrl(pg));
      if (r.clicks > g.topClicks) {
        g.topClicks = r.clicks;
        g.topPage = pg;
      }
      g.parts.push(r);
    }

    const pagesByQuery = new Map<string, Set<string>>();
    const curQueryRows: SaRow[] = [];
    for (const [q, g] of groups) {
      pagesByQuery.set(q, g.pages);
      const impr = g.parts.reduce((s, r) => s + r.impressions, 0);
      const clicks = g.parts.reduce((s, r) => s + r.clicks, 0);
      const position = impr ? g.parts.reduce((s, r) => s + r.position * r.impressions, 0) / impr : 0;
      const ctr = impr ? clicks / impr : 0;
      curQueryRows.push({ keys: [q, g.topPage], clicks, impressions: impr, ctr, position });
    }

    const queryRows: QueryRow[] = buildQueryRows(curQueryRows, qPrev, pagesByQuery);

    // GSC lists http:// , https:// and www / non-www of the same page as
    // separate rows. Collapse them by normalised URL, sum the metrics, and
    // keep the variant Google actually shows users (most impressions) as the
    // one URL we inspect — otherwise a redirect artifact like
    // `http://example.com/` gets inspected and flagged as blocked / redirected.
    const pageGroups = new Map<
      string,
      { url: string; clicks: number; impressions: number; ctr: number; position: number; best: number }
    >();
    for (const r of byPage) {
      if (!r.keys[0]) continue;
      const key = normUrl(r.keys[0]);
      const g = pageGroups.get(key);
      if (!g) {
        pageGroups.set(key, {
          url: r.keys[0],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
          best: r.impressions,
        });
      } else {
        g.clicks += r.clicks;
        g.impressions += r.impressions;
        if (r.impressions > g.best) {
          g.best = r.impressions;
          g.url = r.keys[0];
          g.ctr = r.ctr;
          g.position = r.position;
        }
      }
    }
    const pageMetrics = [...pageGroups.values()]
      .map((g) => ({ url: g.url, clicks: g.clicks, impressions: g.impressions, ctr: g.ctr, position: g.position }))
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
    const page1Queries = queryRows.filter((q) => q.position > 0 && q.position <= 10).length;
    const top3Queries = queryRows.filter((q) => q.position > 0 && q.position <= 3).length;

    // Previous run's page-1 count, so the delta is real over time (not the
    // "new" placeholder). Cheap: it is a denormalised column now.
    const prevPage1 = prevAudit
      ? (await this.prisma.seoAudit.findUnique({ where: { id: prevAudit.id }, select: { page1Queries: true } }))
          ?.page1Queries ?? null
      : null;

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
          page1Queries,
          prevPage1,
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
        page1Queries,
        top3Queries,
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
          page1Queries: true,
          top3Queries: true,
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

    const deltas = previous
      ? this.diff(previous, {
          score: current.score ?? 0,
          clicks: current.clicks,
          impressions: current.impressions,
          ctr: current.ctr,
          position: current.position,
          criticalCount: 0,
          notIndexed: 0,
          strikingCount: 0,
          page1Queries: current.page1Queries,
          prevPage1: previous.page1Queries,
        }).filter((d) => d.previous !== null || d.current !== null)
      : [];

    return {
      currentAuditId: current.id,
      previousAuditId: previous?.id ?? null,
      currentAt: current.createdAt.toISOString(),
      previousAt: previous?.createdAt.toISOString() ?? null,
      deltas,
      pageChanges: previous ? await this.pageChanges(current.id, previous.id) : emptyPageChanges(),
      queryChanges: previous ? await this.queryChanges(current.id, previous.id) : { enteredPage1: [], leftPage1: [] },
    };
  }

  /** How individual URLs moved between two runs — the "how your pages evolved" view. */
  private async pageChanges(curId: string, prevId: string) {
    const [cur, prev] = await Promise.all([
      this.prisma.seoPage.findMany({
        where: { auditId: curId },
        select: { url: true, position: true, clicks: true, impressions: true, coverageState: true, issues: true },
      }),
      this.prisma.seoPage.findMany({
        where: { auditId: prevId },
        select: { url: true, position: true, coverageState: true, issues: true },
      }),
    ]);
    const prevBy = new Map(prev.map((p) => [normUrl(p.url), p]));
    const isIndexed = (cov: string | null) => !!cov && /indexed/i.test(cov) && !/not indexed/i.test(cov);
    const hadIssue = (raw: string | null) => {
      try {
        return (JSON.parse(raw ?? '[]') as unknown[]).length > 0;
      } catch {
        return false;
      }
    };

    const improved: Array<{ url: string; from: number; to: number }> = [];
    const regressed: Array<{ url: string; from: number; to: number }> = [];
    const nowIndexed: string[] = [];
    const lostIndex: string[] = [];
    const nowClean: string[] = [];
    const added: string[] = [];

    for (const c of cur) {
      const p = prevBy.get(normUrl(c.url));
      if (!p) {
        added.push(c.url);
        continue;
      }
      const from = p.position || 0;
      const to = c.position || 0;
      if (from > 0 && to > 0 && from - to >= 3) improved.push({ url: c.url, from: round(from, 1), to: round(to, 1) });
      else if (from > 0 && to > 0 && to - from >= 3) regressed.push({ url: c.url, from: round(from, 1), to: round(to, 1) });
      // index-status transitions only mean something when both runs actually
      // URL-inspected this page — an un-inspected row (outside the budget this
      // run) has a null coverageState and must not read as "fell out of index".
      const bothInspected = !!p.coverageState && !!c.coverageState;
      if (bothInspected && !isIndexed(p.coverageState) && isIndexed(c.coverageState)) nowIndexed.push(c.url);
      if (bothInspected && isIndexed(p.coverageState) && !isIndexed(c.coverageState)) lostIndex.push(c.url);
      if (bothInspected && hadIssue(p.issues) && !hadIssue(c.issues)) nowClean.push(c.url);
    }
    const curUrls = new Set(cur.map((c) => normUrl(c.url)));
    const dropped = prev.filter((p) => !curUrls.has(normUrl(p.url))).map((p) => p.url);

    improved.sort((a, b) => b.from - b.to - (a.from - a.to));
    regressed.sort((a, b) => b.to - b.from - (a.to - a.from));
    return { improved, regressed, nowIndexed, lostIndex, nowClean, added, dropped };
  }

  /** Which keywords entered / left page 1 since the previous run. */
  private async queryChanges(curId: string, prevId: string) {
    const [cur, prev] = await Promise.all([
      this.prisma.seoQuery.findMany({ where: { auditId: curId }, select: { query: true, position: true } }),
      this.prisma.seoQuery.findMany({ where: { auditId: prevId }, select: { query: true, position: true } }),
    ]);
    const prevBy = new Map(prev.map((q) => [q.query, q.position]));
    const enteredPage1: Array<{ query: string; from: number | null; to: number }> = [];
    const leftPage1: Array<{ query: string; from: number; to: number | null }> = [];
    for (const c of cur) {
      const p = prevBy.get(c.query) ?? null;
      const onNow = c.position > 0 && c.position <= 10;
      const wasThen = p !== null && p > 0 && p <= 10;
      if (onNow && !wasThen) enteredPage1.push({ query: c.query, from: p, to: round(c.position, 1) });
    }
    for (const p of prev) {
      const c = cur.find((x) => x.query === p.query)?.position ?? null;
      const wasOn = p.position > 0 && p.position <= 10;
      const onNow = c !== null && c > 0 && c <= 10;
      if (wasOn && !onNow) leftPage1.push({ query: p.query, from: round(p.position, 1), to: c });
    }
    return { enteredPage1: enteredPage1.slice(0, 20), leftPage1: leftPage1.slice(0, 20) };
  }

  async trend(projectId: string, limit = 30) {
    const rows = await this.prisma.seoAudit.findMany({
      where: { projectId, score: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        score: true,
        clicks: true,
        impressions: true,
        position: true,
        page1Queries: true,
        triggeredBy: true,
      },
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
          page1Queries: r.page1Queries,
          triggeredBy: r.triggeredBy,
        }))
        .reverse(),
    };
  }

  /* ── recurring schedule (the `seo*` columns of ScheduleConfig) ───────── */

  async getSchedule(projectId: string) {
    const c = await this.prisma.scheduleConfig.findUnique({ where: { projectId } });
    return {
      cadence: c?.seoCadence ?? 'manual-only',
      nextRunAt: c?.seoNextRunAt?.toISOString() ?? null,
      active: c?.seoActive ?? false,
      lastRunAt: c?.seoLastRunAt?.toISOString() ?? null,
      lastError: c?.seoLastError ?? null,
    };
  }

  async setSchedule(projectId: string, cadence: 'daily' | 'weekly' | 'monthly' | 'manual-only') {
    if (cadence === 'manual-only') {
      await this.prisma.scheduleConfig.upsert({
        where: { projectId },
        create: { projectId, seoCadence: cadence, seoActive: false, seoNextRunAt: null },
        update: { seoCadence: cadence, seoActive: false, seoNextRunAt: null, seoLastError: null },
      });
      return { cadence, nextRunAt: null, active: false, lastRunAt: null, lastError: null };
    }
    const days = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : 30;
    const nextRunAt = new Date(Date.now() + days * 86_400_000);
    await this.prisma.scheduleConfig.upsert({
      where: { projectId },
      create: { projectId, seoCadence: cadence, seoActive: true, seoNextRunAt: nextRunAt },
      update: { seoCadence: cadence, seoActive: true, seoNextRunAt: nextRunAt, seoLastError: null },
    });
    const c = await this.prisma.scheduleConfig.findUnique({ where: { projectId } });
    return {
      cadence,
      nextRunAt: nextRunAt.toISOString(),
      active: true,
      lastRunAt: c?.seoLastRunAt?.toISOString() ?? null,
      lastError: null,
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
      page1Queries: number;
      prevPage1: number | null;
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
      mk('page1', 'Keywords on page 1', cur.prevPage1, cur.page1Queries, true),
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

function emptyPageChanges() {
  return { improved: [], regressed: [], nowIndexed: [], lostIndex: [], nowClean: [], added: [], dropped: [] };
}
function emptyRow(): SaRow {
  return { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
}
function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
