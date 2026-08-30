/**
 * Internal-Link Service — crawl the client's own site, build its internal link
 * graph, and emit "add link A → B" recommendations (Agent #8).
 *
 * Pipeline: BFS crawl (bounded pages/depth, same host) → parse each page →
 * topic keywords (deterministic TF) → node/edge graph → orphans + under-linked
 * hubs → recommendations from keyword overlap + inbound deficit. An optional
 * LLM pass only rewrites anchor text / reason copy (gated on ANTHROPIC_API_KEY).
 *
 * Client-site only: the crawl root defaults to the project's own domain and all
 * fetches go through FetcherService (central rate-limit + logging). The
 * `fixture://` source is offline-test scaffolding, gated by
 * INTERNAL_LINK_ALLOW_FIXTURE.
 *
 * @module internal-link.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { FixturePageSource, HttpPageSource } from './page-source';
import {
  buildRecommendations,
  computeDegrees,
  parsePage,
  pathOf,
  resolveInternal,
  topicKeywords,
} from './link-analyzer';
import { INTERNAL_LINK_LIMITS } from './internal-link.types';
import type {
  AnalyzeInput,
  GraphNode,
  PageSource,
  WorkingEdge,
  WorkingNode,
  WorkingRecommendation,
} from './internal-link.types';

@Injectable()
export class InternalLinkService {
  private readonly logger = new Logger(InternalLinkService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fetcher: FetcherService,
  ) {}

  /**
   * Run a full analysis for a project. Synchronous end-to-end (crawl is bounded
   * and rate-limited by FetcherService).
   * @throws NotFoundException          project missing.
   * @throws BadRequestException        fixture root without INTERNAL_LINK_ALLOW_FIXTURE.
   * @throws ServiceUnavailableException useLlm without ANTHROPIC_API_KEY.
   */
  async analyze(projectId: string, input: AnalyzeInput) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const rootUrl = (input.rootUrl?.trim() || `https://${project.domain}`).replace(/\/+$/, '') || `https://${project.domain}`;
    const useLlm = input.useLlm === true;
    if (useLlm && !this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY not configured — internal-link LLM refinement unavailable (omit useLlm)',
      );
    }

    const isFixture = FixturePageSource.isFixtureUrl(rootUrl);
    if (isFixture && this.config.get<string>('INTERNAL_LINK_ALLOW_FIXTURE') !== '1') {
      throw new BadRequestException('fixture:// roots require INTERNAL_LINK_ALLOW_FIXTURE=1 (offline test only)');
    }

    const maxPages = clamp(
      input.maxPages ?? INTERNAL_LINK_LIMITS.maxPages.default,
      INTERNAL_LINK_LIMITS.maxPages.min,
      INTERNAL_LINK_LIMITS.maxPages.max,
    );
    const maxDepth = clamp(
      input.maxDepth ?? INTERNAL_LINK_LIMITS.maxDepth.default,
      INTERNAL_LINK_LIMITS.maxDepth.min,
      INTERNAL_LINK_LIMITS.maxDepth.max,
    );

    const source: PageSource = isFixture
      ? new FixturePageSource(FixturePageSource.siteName(rootUrl))
      : new HttpPageSource(this.fetcher);
    const origin = isFixture ? FixturePageSource.origin(rootUrl) : originOf(rootUrl);

    const graph = await this.prisma.linkGraph.create({
      data: {
        projectId,
        rootUrl,
        maxPages,
        maxDepth,
        source: source.kind,
        status: 'crawling',
        recSource: useLlm ? 'llm' : 'deterministic',
      },
    });

    try {
      const { nodes, edges } = await this.crawl(source, rootUrl, origin, maxPages, maxDepth);
      await this.prisma.linkGraph.update({ where: { id: graph.id }, data: { status: 'analyzing', pagesCrawled: nodes.length } });

      const rootPath = pathOf(rootUrl === origin ? origin + '/' : rootUrl, origin);
      const graphNodes = computeDegrees(nodes, edges, rootPath);

      // Degraded crawl: several pages fetched but not one internal <a href> parsed.
      // That is a JS-rendered nav, not 49 orphans — skip orphan / under-linked
      // analysis (it would emit confident nonsense) and report the real cause.
      const degraded = edges.length === 0 && graphNodes.length >= 3;
      let recs = degraded ? [] : buildRecommendations(graphNodes, edges, rootPath);
      let recModel: string | null = null;
      if (useLlm && recs.length > 0) {
        const refined = await this.refineRecommendations(recs, graphNodes);
        recs = refined.recs;
        recModel = refined.model;
      }
      if (degraded) for (const n of graphNodes) n.isOrphan = false;

      await this.persist(graph.id, graphNodes, edges, recs);

      const orphanCount = graphNodes.filter((n) => n.isOrphan).length;
      const finished = await this.prisma.linkGraph.update({
        where: { id: graph.id },
        data: {
          status: 'complete',
          pagesCrawled: graphNodes.length,
          edgeCount: edges.length,
          orphanCount,
          recommendationCount: recs.length,
          recModel,
          error: degraded
            ? `Crawl found 0 internal links across ${graphNodes.length} pages — the site's navigation is rendered by JavaScript, so static crawlers and AI retrievers can't follow it. Fix: emit real <a href> nav links in the server HTML. Orphan / under-linked analysis was skipped.`
            : null,
          finishedAt: new Date(),
        },
      });
      this.logger.log(
        `link graph ${graph.id} complete: ${graphNodes.length} pages, ${edges.length} edges, ` +
          `${orphanCount} orphans, ${recs.length} recommendations`,
      );
      return this.getGraph(finished.id);
    } catch (err) {
      await this.prisma.linkGraph.update({
        where: { id: graph.id },
        data: { status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date() },
      });
      throw err;
    }
  }

  async list(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return this.prisma.linkGraph.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  async getGraph(graphId: string) {
    const graph = await this.prisma.linkGraph.findUnique({
      where: { id: graphId },
      include: {
        nodes: { orderBy: [{ depth: 'asc' }, { path: 'asc' }] },
        edges: { orderBy: [{ fromPath: 'asc' }, { toPath: 'asc' }] },
        recommendations: { orderBy: [{ priority: 'desc' }, { fromPath: 'asc' }] },
      },
    });
    if (!graph) throw new NotFoundException('Link graph not found: ' + graphId);
    return graph;
  }

  async listRecommendations(graphId: string, status?: string) {
    await this.getGraphOr404(graphId);
    return this.prisma.linkRecommendation.findMany({
      where: { graphId, ...(status ? { status } : {}) },
      orderBy: [{ priority: 'desc' }, { fromPath: 'asc' }],
    });
  }

  async updateRecommendation(graphId: string, recId: string, status: string) {
    await this.getGraphOr404(graphId);
    const rec = await this.prisma.linkRecommendation.findUnique({ where: { id: recId } });
    if (!rec || rec.graphId !== graphId) throw new NotFoundException('Recommendation not found: ' + recId);
    return this.prisma.linkRecommendation.update({ where: { id: recId }, data: { status } });
  }

  async deleteGraph(graphId: string) {
    await this.getGraphOr404(graphId);
    await this.prisma.linkGraph.delete({ where: { id: graphId } });
    return { removed: graphId };
  }

  // ─── crawl ──────────────────────────────────────────────────

  private async crawl(
    source: PageSource,
    rootUrl: string,
    origin: string,
    maxPages: number,
    maxDepth: number,
  ): Promise<{ nodes: WorkingNode[]; edges: WorkingEdge[] }> {
    const startUrl = rootUrl === origin ? origin + '/' : rootUrl;
    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
    const seen = new Set<string>([pathOf(startUrl, origin)]);
    const nodes: WorkingNode[] = [];
    const edges: WorkingEdge[] = [];

    // Seed from a sitemap / page inventory so orphans (pages BFS can't reach
    // because nothing links to them) still get crawled and flagged.
    let seeds: string[] = [];
    try {
      seeds = await source.discoverSeeds(rootUrl);
    } catch {
      seeds = [];
    }
    for (const seedUrl of seeds) {
      const p = pathOf(seedUrl, origin);
      if (!seen.has(p)) {
        seen.add(p);
        queue.push({ url: seedUrl, depth: 1 });
      }
    }

    while (queue.length > 0 && nodes.length < maxPages) {
      const { url, depth } = queue.shift() as { url: string; depth: number };
      let page;
      try {
        page = await source.fetchPage(url);
      } catch (err) {
        this.logger.warn(`crawl fetch failed ${url}: ${(err as Error).message}`);
        continue;
      }
      const fromPath = pathOf(page.url || url, origin);
      const parsed = parsePage(page.html);
      nodes.push({
        path: fromPath,
        url: page.url || url,
        title: parsed.title,
        h1: parsed.h1,
        wordCount: parsed.wordCount,
        topicKeywords: topicKeywords(`${parsed.title ?? ''} ${parsed.h1 ?? ''} ${parsed.text}`),
        depth,
        httpStatus: page.status,
      });

      if (page.status >= 400 || !parsed.text) continue;

      for (const link of parsed.links) {
        const abs = resolveInternal(link.href, page.url || url, origin);
        if (!abs) continue;
        const toPath = pathOf(abs, origin);
        if (toPath === fromPath) continue;
        edges.push({
          fromPath,
          toPath,
          anchorText: link.anchor.slice(0, 200),
          rel: link.rel,
          context: link.context || null,
        });
        if (!seen.has(toPath) && depth + 1 <= maxDepth && seen.size < maxPages * 4) {
          seen.add(toPath);
          queue.push({ url: abs, depth: depth + 1 });
        }
      }
    }

    // Drop edges whose target was never crawled (out of budget/depth) so the
    // graph only reasons about pages we actually analysed.
    const known = new Set(nodes.map((n) => n.path));
    return { nodes, edges: edges.filter((e) => known.has(e.toPath)) };
  }

  // ─── persistence ────────────────────────────────────────────

  private async persist(
    graphId: string,
    nodes: GraphNode[],
    edges: WorkingEdge[],
    recs: WorkingRecommendation[],
  ): Promise<void> {
    for (const n of nodes) {
      await this.prisma.linkNode.create({
        data: {
          graphId,
          url: n.url,
          path: n.path,
          title: n.title,
          h1: n.h1,
          wordCount: n.wordCount,
          topicKeywords: JSON.stringify(n.topicKeywords),
          depth: n.depth,
          httpStatus: n.httpStatus,
          inboundCount: n.inboundCount,
          outboundCount: n.outboundCount,
          isOrphan: n.isOrphan,
          fetchedAt: new Date(),
        },
      });
    }
    for (const e of edges) {
      await this.prisma.linkEdge.create({
        data: {
          graphId,
          fromPath: e.fromPath,
          toPath: e.toPath,
          anchorText: e.anchorText,
          rel: e.rel,
          context: e.context,
        },
      });
    }
    for (const r of recs) {
      await this.prisma.linkRecommendation.create({
        data: {
          graphId,
          fromPath: r.fromPath,
          toPath: r.toPath,
          suggestedAnchor: r.suggestedAnchor,
          reason: r.reason,
          topicOverlap: r.topicOverlap,
          priority: r.priority,
        },
      });
    }
  }

  // ─── optional LLM refinement ────────────────────────────────

  private async refineRecommendations(
    recs: WorkingRecommendation[],
    nodes: GraphNode[],
  ): Promise<{ recs: WorkingRecommendation[]; model: string }> {
    const model = this.config.get<string>('INTERNAL_LINK_LLM_MODEL', 'claude-opus-5');
    try {
      const client = this.ensureClient();
      const byPath = new Map(nodes.map((n) => [n.path, n]));
      const payload = recs.slice(0, 40).map((r) => ({
        fromPath: r.fromPath,
        fromTitle: byPath.get(r.fromPath)?.title ?? r.fromPath,
        toPath: r.toPath,
        toTitle: byPath.get(r.toPath)?.title ?? r.toPath,
        currentAnchor: r.suggestedAnchor,
      }));
      const res = await client.messages.create({
        model,
        max_tokens: 1500,
        system:
          'You improve internal-link suggestions. For each item, return a natural anchor phrase (2-5 words, ' +
          'lowercase unless a proper noun) that would read well as link text on the "from" page pointing to ' +
          'the "to" page. Return ONLY minified JSON: {"anchors":[{"fromPath","toPath","anchor"}]} in the same order.',
        messages: [{ role: 'user', content: JSON.stringify({ items: payload }) }],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end <= start) return { recs, model };
      const parsed = JSON.parse(text.slice(start, end + 1)) as { anchors?: Array<{ fromPath?: string; toPath?: string; anchor?: string }> };
      const map = new Map((parsed.anchors ?? []).map((a) => [`${a.fromPath} ${a.toPath}`, (a.anchor ?? '').trim()]));
      return {
        model,
        recs: recs.map((r) => {
          const a = map.get(`${r.fromPath} ${r.toPath}`);
          return a && a.length >= 2 && a.length <= 60 ? { ...r, suggestedAnchor: a } : r;
        }),
      };
    } catch (err) {
      this.logger.warn(`internal-link LLM refine failed (${(err as Error).message}) — keeping deterministic anchors`);
      return { recs, model };
    }
  }

  private ensureClient(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.get<string>('ANTHROPIC_API_KEY') || undefined });
    }
    return this.anthropic;
  }

  private async getGraphOr404(graphId: string) {
    const g = await this.prisma.linkGraph.findUnique({ where: { id: graphId } });
    if (!g) throw new NotFoundException('Link graph not found: ' + graphId);
    return g;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
