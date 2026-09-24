/**
 * Gap Analysis Service — stage 8, "Findings & Opportunity Analysis".
 *
 * Consolidates evidence from every audit module (technical-audit, entity-
 * audit, digital-presence, tech-stack, competitors, serp-intelligence,
 * aeo-audit), classifies each into issue/gap/opportunity/strength/risk, and
 * scores actionable rows by impact × effort. `strategy.service.ts` (stage 9)
 * reads this module's output and groups it into the nine recommendation
 * categories — this module owns "what did we find and how good/bad is it",
 * strategy owns "what do we tell the client to do about it".
 *
 * Every collector below is read-only: it queries what other modules already
 * measured and stored, and NEVER triggers a new fetch, scan, or paid call —
 * `sync()` must be safe to run on a schedule without spending anything.
 *
 * Mapping table (CLASSIFICATION_RULES) is exported for review — per SPEC
 * §4.4 it should become DB-backed/tunable when engagement tuning demand
 * emerges; for v1 it is a constant, same as `seo-rubric.ts`'s deduction table.
 *
 * `priorityScore` (demandPotential × credibilityImpact × citationLikelihood)
 * predates this pass and stays untouched — it's the PR/outreach-specific
 * score `influence` gaps use, manually scored by a delivery lead. The NEW
 * `impactScore`/`effortScore`/`quadrant` are the general-purpose "Prioritize
 * by Impact & Effort" the flowchart asks for, computed automatically from
 * each rule's disclosed band — no manual input required.
 *
 * Sync is idempotent: @@unique([sourceType, sourceId]) prevents duplicates;
 * re-sync upserts titles/descriptions on auto-assigned fields only.
 *
 * @module gap-analysis.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PresenceService } from '../digital-presence/presence.service';
import type { PresenceGroup } from '../digital-presence/presence.types';
import { PLATFORM_LABELS } from '../digital-presence/presence.types';
import { KeywordResearchService } from '../keyword-research/keyword-research.service';
import {
  computeQuadrant,
  type ClassificationRule,
  type GapAction,
  type GapCategory,
  type GapDimension,
  type RecommendationCategory,
} from './gap-analysis.types';

// ─── Classification table ───────────────────────────────────────────────

export const CLASSIFICATION_RULES: ClassificationRule[] = [
  // ── Technical findings (site-level; fail/error only) ──────────────────
  { sourceType: 'technical-finding', sourceKey: 'robots', match: 'robots', dimension: 'visibility', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 5, effort: 1, title: 'robots.txt blocks AI crawlers' },
  { sourceType: 'technical-finding', sourceKey: 'cdn-inferred', match: 'cdn-inferred', dimension: 'visibility', action: 'fix', category: 'issue', recommendationCategory: 'technology-improvements', impact: 5, effort: 3, title: 'CDN/WAF silently blocks AI crawlers' },
  { sourceType: 'technical-finding', sourceKey: 'js-render', match: 'js-render', dimension: 'visibility', action: 'fix', category: 'issue', recommendationCategory: 'technology-improvements', impact: 4, effort: 5, title: 'JS-render dependency hides content from crawlers' },
  { sourceType: 'technical-finding', sourceKey: 'cwv', match: 'cwv', dimension: 'visibility', action: 'fix', category: 'issue', recommendationCategory: 'technology-improvements', impact: 3, effort: 3, title: 'Core Web Vitals need improvement' },
  { sourceType: 'technical-finding', sourceKey: 'schema-tech', match: 'schema', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 3, effort: 2, title: 'Missing or incomplete JSON-LD structured data' },

  // ── Technical strengths (site-level; pass only — see syncTechnicalStrengths) ──
  { sourceType: 'technical-strength', sourceKey: 'robots-pass', match: 'robots-pass', dimension: 'visibility', action: 'fix', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'AI crawlers are not blocked by robots.txt' },
  { sourceType: 'technical-strength', sourceKey: 'js-render-pass', match: 'js-render-pass', dimension: 'visibility', action: 'fix', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: "Content doesn't depend on client-side JavaScript to render" },
  { sourceType: 'technical-strength', sourceKey: 'cwv-pass', match: 'cwv-pass', dimension: 'visibility', action: 'fix', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: "Core Web Vitals meet Google's thresholds" },
  { sourceType: 'technical-strength', sourceKey: 'schema-pass', match: 'schema-pass', dimension: 'narrative', action: 'fix', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'Structured data is present and complete on the homepage' },

  // ── Per-page rollups (technical-audit's PageInventoryAnalysis) ────────
  { sourceType: 'page-inventory-issue', sourceKey: 'title-missing', match: 'title-missing', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 3, effort: 2, title: 'Pages missing a <title>' },
  { sourceType: 'page-inventory-issue', sourceKey: 'title-too-short', match: 'title-too-short', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 2, effort: 2, title: 'Pages with an under-length title' },
  { sourceType: 'page-inventory-issue', sourceKey: 'title-too-long', match: 'title-too-long', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 2, effort: 2, title: 'Pages with an over-length title' },
  { sourceType: 'page-inventory-issue', sourceKey: 'meta-missing', match: 'meta-missing', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 2, effort: 1, title: 'Pages missing a meta description' },
  { sourceType: 'page-inventory-issue', sourceKey: 'meta-too-short', match: 'meta-too-short', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 1, effort: 1, title: 'Pages with an under-length meta description' },
  { sourceType: 'page-inventory-issue', sourceKey: 'meta-too-long', match: 'meta-too-long', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 1, effort: 1, title: 'Pages with an over-length meta description' },
  { sourceType: 'page-inventory-issue', sourceKey: 'h1-missing', match: 'h1-missing', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'content-strategy', impact: 2, effort: 2, title: 'Pages missing an H1' },
  { sourceType: 'page-inventory-issue', sourceKey: 'h1-multiple', match: 'h1-multiple', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'content-strategy', impact: 2, effort: 2, title: 'Pages with more than one H1' },
  { sourceType: 'page-inventory-issue', sourceKey: 'heading-level-skipped', match: 'heading-level-skipped', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'content-strategy', impact: 2, effort: 2, title: 'Pages with a broken heading hierarchy' },
  { sourceType: 'page-inventory-issue', sourceKey: 'canonical-missing', match: 'canonical-missing', dimension: 'visibility', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 3, effort: 2, title: 'Pages missing a canonical link' },
  { sourceType: 'page-inventory-issue', sourceKey: 'canonical-malformed', match: 'canonical-malformed', dimension: 'visibility', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 3, effort: 2, title: "Pages whose canonical doesn't resolve" },
  { sourceType: 'page-inventory-issue', sourceKey: 'canonical-cross-domain', match: 'canonical-cross-domain', dimension: 'visibility', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 5, effort: 2, title: 'Pages whose canonical points off-site' },
  { sourceType: 'page-inventory-issue', sourceKey: 'json-ld-missing', match: 'json-ld-missing', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 3, effort: 2, title: 'Pages missing JSON-LD structured data' },
  { sourceType: 'page-inventory-issue', sourceKey: 'json-ld-invalid', match: 'json-ld-invalid', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 3, effort: 2, title: "Pages whose JSON-LD doesn't parse" },
  { sourceType: 'page-inventory-issue', sourceKey: 'thin-content', match: 'thin-content', dimension: 'topic', action: 'build', category: 'issue', recommendationCategory: 'content-strategy', impact: 3, effort: 4, title: 'Pages under the content-length floor' },
  { sourceType: 'page-inventory-issue', sourceKey: 'duplicate-content', match: 'duplicate-content', dimension: 'topic', action: 'fix', category: 'issue', recommendationCategory: 'content-strategy', impact: 3, effort: 3, title: 'Pages sharing body copy with another page' },
  { sourceType: 'page-inventory-issue', sourceKey: 'images-missing-alt', match: 'images-missing-alt', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'content-strategy', impact: 2, effort: 1, title: 'Content images with no alt text' },
  { sourceType: 'page-inventory-issue', sourceKey: 'url-too-long', match: 'url-too-long', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 1, effort: 3, title: 'Pages with over-length URLs' },
  { sourceType: 'page-inventory-issue', sourceKey: 'url-has-uppercase', match: 'url-has-uppercase', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 1, effort: 3, title: 'Pages with uppercase letters in the URL' },
  { sourceType: 'page-inventory-issue', sourceKey: 'url-has-underscore', match: 'url-has-underscore', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 1, effort: 3, title: 'Pages using underscores instead of hyphens in the URL' },
  { sourceType: 'page-inventory-issue', sourceKey: 'url-excess-params', match: 'url-excess-params', dimension: 'format', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 2, effort: 3, title: 'Pages with excessive URL query parameters' },
  { sourceType: 'page-inventory-issue', sourceKey: 'page-inventory-strength', match: 'page-inventory-strength', dimension: 'narrative', action: 'fix', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'Strong on-page SEO fundamentals across the crawled site' },

  // ── Entity-audit derived ───────────────────────────────────────────────
  { sourceType: 'schema-check', sourceKey: 'schema-check', match: 'schema-check', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 3, effort: 2, title: 'Schema check failed — missing fields or broken sameAs' },
  { sourceType: 'schema-check', sourceKey: 'sameAs', match: 'sameAs', dimension: 'narrative', action: 'fix', category: 'issue', recommendationCategory: 'seo-improvements', impact: 2, effort: 1, title: 'Broken or stale sameAs links' },
  { sourceType: 'platform-record', sourceKey: 'platform-record', match: 'platform-record', dimension: 'narrative', action: 'influence', category: 'issue', recommendationCategory: 'reputation-strategy', impact: 2, effort: 2, title: 'Platform name/descriptor mismatch' },
  { sourceType: 'model-diff', sourceKey: 'model-diff', match: 'model-diff', dimension: 'narrative', action: 'influence', category: 'risk', recommendationCategory: 'reputation-strategy', impact: 4, effort: 4, title: 'AI model mischaracterizes entity (model-diff divergence)' },

  // ── Tech stack (opportunities: a category with zero detected tools) ──
  { sourceType: 'tech-stack-gap', sourceKey: 'no-analytics', match: 'no-analytics', dimension: 'demand', action: 'build', category: 'issue', recommendationCategory: 'technology-improvements', impact: 4, effort: 1, title: 'No analytics tool detected — traffic and conversions are unmeasured' },
  { sourceType: 'tech-stack-gap', sourceKey: 'no-crm', match: 'no-crm', dimension: 'demand', action: 'build', category: 'opportunity', recommendationCategory: 'technology-improvements', impact: 3, effort: 3, title: 'No CRM/lead-capture tool detected' },
  { sourceType: 'tech-stack-gap', sourceKey: 'no-chat', match: 'no-chat', dimension: 'demand', action: 'build', category: 'opportunity', recommendationCategory: 'conversion-optimization', impact: 3, effort: 2, title: 'No chat/conversion widget detected' },
  { sourceType: 'tech-stack-gap', sourceKey: 'no-ads', match: 'no-ads', dimension: 'demand', action: 'build', category: 'opportunity', recommendationCategory: 'advertising-opportunities', impact: 2, effort: 1, title: 'No ad-tracking pixel detected — paid channels, if any, are unattributed' },
  { sourceType: 'tech-stack-strength', sourceKey: 'full-stack', match: 'full-stack', dimension: 'demand', action: 'build', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'Analytics, CRM and chat tooling are all in place' },

  // ── SERP intelligence ──────────────────────────────────────────────────
  { sourceType: 'serp-gap', sourceKey: 'no-rank', match: 'no-rank', dimension: 'visibility', action: 'build', category: 'gap', recommendationCategory: 'seo-improvements', impact: 3, effort: 3, title: 'Not ranking on page 1 for a tracked keyword' },
  { sourceType: 'serp-gap', sourceKey: 'ai-overview-miss', match: 'ai-overview-miss', dimension: 'visibility', action: 'build', category: 'gap', recommendationCategory: 'search-aeo-strategy', impact: 3, effort: 3, title: "An AI Overview appears for this query and doesn't cite this site" },
  { sourceType: 'serp-gap', sourceKey: 'local-pack-miss', match: 'local-pack-miss', dimension: 'visibility', action: 'build', category: 'gap', recommendationCategory: 'market-expansion', impact: 4, effort: 3, title: 'Not appearing in the local map pack for a tracked keyword' },
  { sourceType: 'serp-strength', sourceKey: 'strong-rank', match: 'strong-rank', dimension: 'visibility', action: 'build', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'Ranking in the top 3 for a tracked keyword' },
  { sourceType: 'serp-strength', sourceKey: 'local-pack-strong', match: 'local-pack-strong', dimension: 'visibility', action: 'build', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'Ranking in the top 3 of the local map pack' },

  // ── AEO audit ───────────────────────────────────────────────────────────
  { sourceType: 'aeo-gap', sourceKey: 'low-mention-rate', match: 'low-mention-rate', dimension: 'demand', action: 'build', category: 'issue', recommendationCategory: 'search-aeo-strategy', impact: 4, effort: 4, title: 'Low unbranded mention rate across answer engines' },
  { sourceType: 'aeo-risk', sourceKey: 'losing-to-competitor', match: 'losing-to-competitor', dimension: 'demand', action: 'influence', category: 'risk', recommendationCategory: 'search-aeo-strategy', impact: 4, effort: 3, title: 'A named competitor is winning while this site is absent' },
  { sourceType: 'aeo-strength', sourceKey: 'sov-leader', match: 'sov-leader', dimension: 'demand', action: 'influence', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'Leading share of voice across measured answer engines' },

  // ── AEO audit — stage 6 "Competitors by Area / Market" ────────────────
  // Only fires on multi-market audits (see syncAeoAudit) — on a single-market
  // audit this would just duplicate the aeo-risk row above.
  { sourceType: 'market-competitor-risk', sourceKey: 'losing-in-market', match: 'losing-in-market', dimension: 'demand', action: 'influence', category: 'risk', recommendationCategory: 'market-expansion', impact: 4, effort: 3, title: 'A named competitor is winning in a specific market while this site is absent' },

  // ── Competitors — SEO/content + reviews (wave-6 step 6 completion) ────
  // Client-vs-rival comparisons live in syncCompetitors(); titles vary per
  // competitor/platform name, so these carry only the shared banding.
  { sourceType: 'competitor-seo-gap', sourceKey: 'seo-ahead', match: 'seo-ahead', dimension: 'topic', action: 'build', category: 'gap', recommendationCategory: 'content-strategy', impact: 3, effort: 4, title: "A competitor's homepage scores higher on-page SEO than this site's average" },
  { sourceType: 'competitor-seo-strength', sourceKey: 'seo-ahead-client', match: 'seo-ahead-client', dimension: 'topic', action: 'build', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: "This site's average on-page SEO score beats a tracked competitor's homepage" },
  { sourceType: 'competitor-review-gap', sourceKey: 'no-reviews', match: 'no-reviews', dimension: 'web-mentions', action: 'influence', category: 'gap', recommendationCategory: 'reputation-strategy', impact: 3, effort: 3, title: 'Competitor(s) have a published rating where this site has none' },
  { sourceType: 'competitor-review-risk', sourceKey: 'lower-rating', match: 'lower-rating', dimension: 'web-mentions', action: 'influence', category: 'risk', recommendationCategory: 'reputation-strategy', impact: 3, effort: 4, title: 'Rated lower than a competitor on a shared review platform' },
  { sourceType: 'competitor-review-strength', sourceKey: 'higher-rating', match: 'higher-rating', dimension: 'web-mentions', action: 'influence', category: 'strength', recommendationCategory: null, impact: null, effort: null, title: 'Rated higher than every tracked competitor on a shared review platform' },

  // ── Keyword research — stage 10 "Select Priority Keywords to Target" ──
  { sourceType: 'keyword-opportunity', sourceKey: 'priority-keyword', match: 'priority-keyword', dimension: 'topic', action: 'build', category: 'opportunity', recommendationCategory: 'content-strategy', impact: 3, effort: 3, title: 'High-priority keyword with real search demand, uncovered by a tracked content push' },

  // Presence gap/review/strength titles are built inline (per-platform text),
  // so they carry no static row here — see syncDigitalPresence(). Competitor
  // gap/strength similarly vary per platform/tech name — see syncCompetitors().
];

function computePriorityScore(demand: number | null, credibility: number | null, citation: number | null): number | null {
  if (demand == null || credibility == null || citation == null) return null;
  return demand * credibility * citation;
}

/** Where a digital-presence platform group lands in the stage-9 action plan. */
const GROUP_TO_RECOMMENDATION: Record<PresenceGroup, RecommendationCategory> = {
  social: 'social-strategy',
  review: 'reputation-strategy',
  directory: 'seo-improvements',
  marketplace: 'market-expansion',
  publishing: 'content-strategy',
  personal: 'social-strategy',
  other: 'seo-improvements',
};

function classify(sourceType: string, sourceKey: string): ClassificationRule | null {
  const key = sourceKey.toLowerCase();
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.sourceType !== sourceType) continue;
    if (rule.match.toLowerCase() === key) return rule;
  }
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.sourceType !== sourceType) continue;
    if (key.includes(rule.match.toLowerCase()) || rule.match.toLowerCase().includes(key)) return rule;
  }
  return null;
}

/** What `upsertGap` needs — a resolved classification plus the row's own copy. */
interface GapInput {
  sourceType: string;
  sourceId: string;
  dimension: GapDimension;
  action: GapAction;
  category: GapCategory;
  recommendationCategory: RecommendationCategory | null;
  impact: number | null;
  effort: number | null;
  title: string;
  description: string;
  severity: string;
}

@Injectable()
export class GapAnalysisService {
  private readonly logger = new Logger(GapAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly keywordResearch: KeywordResearchService,
  ) {}

  private async getOrCreateAnalysis(projectId: string) {
    let analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) {
      try {
        analysis = await this.prisma.gapAnalysis.create({ data: { projectId } });
      } catch (e: any) {
        if (e?.code === 'P2002') {
          analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
          if (!analysis) throw e;
        } else {
          throw e;
        }
      }
    }
    return analysis;
  }

  /** List gaps for a project, filterable by dimension/action/category/status. */
  async listGaps(projectId: string, filters: { dimension?: string; action?: string; category?: string; status?: string }) {
    const analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) return { id: '', projectId, gaps: [], count: 0 };

    const where: any = { gapAnalysisId: analysis.id };
    if (filters.dimension) where.dimension = filters.dimension;
    if (filters.action) where.action = filters.action;
    if (filters.category) where.category = filters.category;
    if (filters.status) where.status = filters.status;

    const gaps = await this.prisma.gap.findMany({ where });
    gaps.sort((a, b) => {
      if (a.priorityScore != null && b.priorityScore != null) return b.priorityScore - a.priorityScore;
      if (a.priorityScore != null) return -1;
      if (b.priorityScore != null) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    return { id: analysis.id, projectId, gaps, count: gaps.length };
  }

  async getGap(projectId: string, gapId: string) {
    const gap = await this.prisma.gap.findUnique({ where: { id: gapId }, include: { gapAnalysis: true } });
    if (!gap || gap.gapAnalysis.projectId !== projectId) {
      throw new NotFoundException(`Gap ${gapId} not found in project ${projectId}`);
    }
    return gap;
  }

  /**
   * Grouped by {@link GapCategory} — the SWOT-style read stage 8 asks for.
   * Each group sorted worst/best-first: issues and risks by impact desc
   * (the one a client should read first is the biggest problem), gaps and
   * opportunities the same way, strengths by recency (there's no "biggest"
   * strength to rank, only "most recently confirmed").
   */
  async byCategory(projectId: string) {
    const analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) return { projectId, groups: [], total: 0 };
    const gaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id } });

    const order: GapCategory[] = ['issue', 'risk', 'gap', 'opportunity', 'strength'];
    const groups = order.map((category) => {
      const rows = gaps
        .filter((g) => g.category === category)
        .sort((a, b) => {
          if (category === 'strength') return b.createdAt.getTime() - a.createdAt.getTime();
          return (b.impactScore ?? 0) - (a.impactScore ?? 0);
        });
      return { category, gaps: rows, count: rows.length };
    });

    return { projectId, groups, total: gaps.length };
  }

  /**
   * Grouped by {@link ImpactEffortQuadrant} — "Prioritize by Impact & Effort",
   * literally. Strengths never appear here (see {@link computeQuadrant}).
   */
  async matrix(projectId: string) {
    const analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) return { projectId, quadrants: [], total: 0 };
    const gaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id, quadrant: { not: null } } });

    const order = ['quick-win', 'major-project', 'fill-in', 'thankless-task'] as const;
    const quadrants = order.map((quadrant) => {
      const rows = gaps
        .filter((g) => g.quadrant === quadrant)
        .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0));
      return { quadrant, gaps: rows, count: rows.length };
    });

    return { projectId, quadrants, total: gaps.length };
  }

  // ─── Sync ────────────────────────────────────────────────────────────

  /**
   * Re-run auto-classification against every source module's latest data.
   * Idempotent — upserts by (sourceType, sourceId); prunes gaps whose source
   * no longer qualifies. Read-only: never triggers a scan, crawl, or paid call.
   */
  async sync(projectId: string) {
    const analysis = await this.getOrCreateAnalysis(projectId);
    let created = 0;
    let updated = 0;
    const validSourceIds = new Set<string>();

    const bump = (r: { created: boolean }) => (r.created ? created++ : updated++);
    const run = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        this.logger.warn(`Gap sync source "${label}" failed for ${projectId}: ${(err as Error).message}`);
      }
    };

    await run('technical-findings', () => this.syncTechnicalFindings(analysis.id, projectId, validSourceIds, bump));
    await run('technical-strengths', () => this.syncTechnicalStrengths(analysis.id, projectId, validSourceIds, bump));
    await run('page-inventory', () => this.syncPageInventory(analysis.id, projectId, validSourceIds, bump));
    await run('entity-audit', () => this.syncEntityAudit(analysis.id, projectId, validSourceIds, bump));
    await run('digital-presence', () => this.syncDigitalPresence(analysis.id, projectId, validSourceIds, bump));
    await run('social-activity', () => this.syncSocialActivity(analysis.id, projectId, validSourceIds, bump));
    await run('tech-stack', () => this.syncTechStack(analysis.id, projectId, validSourceIds, bump));
    await run('competitors', () => this.syncCompetitors(analysis.id, projectId, validSourceIds, bump));
    await run('serp-intelligence', () => this.syncSerpIntelligence(analysis.id, projectId, validSourceIds, bump));
    await run('aeo-audit', () => this.syncAeoAudit(analysis.id, projectId, validSourceIds, bump));
    await run('keyword-research', () => this.syncKeywordOpportunities(analysis.id, projectId, validSourceIds, bump));

    // Prune stale gaps: source no longer qualifies (finding now passes, or a
    // re-run of the same module produced a different set of source ids).
    const existingGaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id }, select: { id: true, sourceType: true, sourceId: true } });
    let pruned = 0;
    for (const g of existingGaps) {
      if (!validSourceIds.has(`${g.sourceType}:${g.sourceId}`)) {
        await this.prisma.gap.delete({ where: { id: g.id } });
        pruned++;
      }
    }

    this.logger.log(`Gap sync for ${projectId}: ${created} created, ${updated} updated, ${pruned} pruned`);
    const gaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id }, orderBy: { createdAt: 'desc' } });
    return { id: analysis.id, projectId, created, updated, pruned, gaps, count: gaps.length };
  }

  // ── Source 1: technical-audit findings (fail/error) ──────────────────

  private async syncTechnicalFindings(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const audits = await this.prisma.technicalAudit.findMany({ where: { projectId }, include: { findings: true } });
    for (const audit of audits) {
      for (const f of audit.findings) {
        if (f.status !== 'fail' && f.status !== 'error') continue;
        const cls = classify('technical-finding', f.type);
        if (!cls) continue;
        validSourceIds.add(`technical-finding:${f.id}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'technical-finding',
            sourceId: f.id,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title} (${f.type})`,
            description: f.recommendedFix,
            severity: f.severity,
          }),
        );
      }
    }
  }

  // ── Source 2: technical-audit findings (pass) — the NEW strengths ────

  private async syncTechnicalStrengths(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const audit = await this.prisma.technicalAudit.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, include: { findings: true } });
    if (!audit) return;

    const passKeyFor: Record<string, string> = { robots: 'robots-pass', 'js-render': 'js-render-pass', cwv: 'cwv-pass', schema: 'schema-pass' };
    for (const f of audit.findings) {
      if (f.status !== 'pass') continue;
      const key = passKeyFor[f.type];
      if (!key) continue;
      const cls = classify('technical-strength', key);
      if (!cls) continue;
      const sourceId = `${audit.id}:${key}`;
      validSourceIds.add(`technical-strength:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'technical-strength',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: cls.title,
          description: `Confirmed on the latest technical audit (${audit.id}).`,
          severity: 'low',
        }),
      );
    }
  }

  // ── Source 3: page-inventory rollups (site-wide issue counts) ────────

  private async syncPageInventory(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const audit = await this.prisma.technicalAudit.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { pages: true },
    });
    if (!audit || audit.pages.length === 0) return;

    const ok = audit.pages.filter((p) => {
      try {
        return !(JSON.parse(p.issues || '[]') as string[]).includes('page-error');
      } catch {
        return true;
      }
    });
    if (ok.length === 0) return;

    const issueCounts: Record<string, number> = {};
    for (const p of ok) {
      let issues: string[] = [];
      try {
        issues = JSON.parse(p.issues || '[]') as string[];
      } catch {
        continue;
      }
      for (const i of issues) issueCounts[i] = (issueCounts[i] ?? 0) + 1;
    }

    for (const [issueCode, count] of Object.entries(issueCounts)) {
      if (count === 0) continue;
      const cls = classify('page-inventory-issue', issueCode);
      if (!cls) continue;
      const sourceId = `${audit.id}:${issueCode}`;
      validSourceIds.add(`page-inventory-issue:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'page-inventory-issue',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: cls.category,
          recommendationCategory: cls.recommendationCategory,
          impact: cls.impact,
          effort: cls.effort,
          title: `${cls.title} (${count} of ${ok.length} crawled)`,
          description: `${count} of ${ok.length} successfully crawled pages carry this issue, from the audit run on ${audit.createdAt.toISOString().slice(0, 10)}.`,
          severity: count / ok.length > 0.5 ? 'high' : count / ok.length > 0.2 ? 'medium' : 'low',
        }),
      );
    }

    // One aggregate strength when the crawl is clean across the bands that
    // matter most — never one row per page, which would just be noise.
    const avgScore = Math.round(ok.reduce((s, p) => s + (p.score ?? 0), 0) / ok.length);
    const dirtyCodes = ['thin-content', 'duplicate-content', 'images-missing-alt', 'title-missing', 'json-ld-missing'];
    const isClean = avgScore >= 85 && dirtyCodes.every((c) => !issueCounts[c]);
    if (isClean) {
      const cls = classify('page-inventory-issue', 'page-inventory-strength')!;
      const sourceId = `${audit.id}:page-inventory-strength`;
      validSourceIds.add(`page-inventory-issue:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'page-inventory-issue',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: `${cls.title} (avg score ${avgScore}/100 across ${ok.length} pages)`,
          description: `No thin, duplicate, or under-described pages found across ${ok.length} crawled pages; average rubric score ${avgScore}/100.`,
          severity: 'low',
        }),
      );
    }
  }

  // ── Source 4: entity-audit (schema checks, platform records, model diffs) ──

  private async syncEntityAudit(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const entityAudit = await this.prisma.entityAudit.findFirst({
      where: { projectId },
      include: { entities: { include: { schemaChecks: true, platformRecords: true, modelDiffs: true } } },
    });
    if (!entityAudit) return;

    let allSchemaChecksPass = true;
    let anySchemaCheck = false;

    for (const entity of entityAudit.entities) {
      for (const sc of entity.schemaChecks) {
        anySchemaCheck = true;
        if (sc.status !== 'fail' && sc.status !== 'error') continue;
        allSchemaChecksPass = false;
        const verification = typeof sc.sameAsVerification === 'string' ? (JSON.parse(sc.sameAsVerification) as any) : (sc.sameAsVerification as any);
        const hasBroken = Array.isArray(verification) && verification.some((v: any) => !v.resolves || v.identityMatch === false);
        const key = hasBroken ? 'sameAs' : 'schema-check';
        const cls = classify('schema-check', key);
        if (!cls) continue;
        const missingRaw = typeof sc.fieldsMissing === 'string' ? (JSON.parse(sc.fieldsMissing || '[]') as string[]) : (sc.fieldsMissing as any);
        const missing = (missingRaw as string[] | null)?.join(', ') || '';
        validSourceIds.add(`schema-check:${sc.id}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'schema-check',
            sourceId: sc.id,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title} — ${entity.name}`,
            description: missing ? `Missing fields: ${missing}. Schema type: ${sc.schemaType || 'none'}.` : `Schema issue for entity ${entity.name}.`,
            severity: sc.status === 'fail' ? 'medium' : 'low',
          }),
        );
      }

      for (const pr of entity.platformRecords) {
        if (pr.consistencyStatus !== 'mismatch') continue;
        const cls = classify('platform-record', 'platform-record')!;
        validSourceIds.add(`platform-record:${pr.id}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'platform-record',
            sourceId: pr.id,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title} — ${entity.name} on ${pr.platform}`,
            description: `Platform ${pr.platform} shows "${pr.recordedName}" vs entity "${entity.name}"${pr.sourceUrl ? ` (${pr.sourceUrl})` : ''}.`,
            severity: 'medium',
          }),
        );
      }

      for (const md of entity.modelDiffs) {
        if (md.status !== 'completed') continue;
        // `divergence` is a free-text judge verdict, not the {score,summary}
        // JSON the original SPEC envisioned (entity-audit.service.ts's
        // judgeDivergence() prompts the model to start its reply "Aligned:" or
        // "Divergent:" — see its system prompt). A `.score` read here was
        // always undefined against a string, so this source never fired.
        const divergence = typeof md.divergence === 'string' ? md.divergence : null;
        if (!divergence || !divergence.trim().toLowerCase().startsWith('divergent')) continue;
        const cls = classify('model-diff', 'model-diff')!;
        validSourceIds.add(`model-diff:${md.id}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'model-diff',
            sourceId: md.id,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title} — ${entity.name} (${md.provider})`,
            description: divergence,
            severity: 'high',
          }),
        );
      }
    }

    // No dedicated CLASSIFICATION_RULES row for this one — it's a one-off,
    // whole-entity-audit strength, not a per-issue-code table lookup.
    if (anySchemaCheck && allSchemaChecksPass) {
      const sourceId = `${entityAudit.id}:schema-clean`;
      validSourceIds.add(`schema-check:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'schema-check',
          sourceId,
          dimension: 'narrative',
          action: 'fix',
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: 'Every checked entity has clean, resolving structured data',
          description: 'No schema-check failures across the entities audited — sameAs links resolve and required fields are present.',
          severity: 'low',
        }),
      );
    }
  }

  // ── Source 5: digital-presence (expected-platform gaps, reviews) ─────

  private async syncDigitalPresence(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    // Pure read + compute — never a fresh crawl (see presence.service.ts).
    const inventory = await this.presence.inventory(projectId);

    for (const gap of inventory.gaps) {
      const recCat = GROUP_TO_RECOMMENDATION[gap.group];
      const sourceId = `${projectId}:${gap.platform}`;
      validSourceIds.add(`presence-gap:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'presence-gap',
          sourceId,
          dimension: 'web-mentions',
          action: 'build',
          category: 'gap',
          recommendationCategory: recCat,
          impact: 3,
          effort: 2,
          title: `No ${gap.label} presence`,
          description: `Expected for this business type (${inventory.assessment.businessProfileLabel}), and not found by the crawl or the operator-confirmed accounts.`,
          severity: 'medium',
        }),
      );
    }

    // Full expected coverage across every category = a strength, checked
    // once per sync rather than the absence of every possible gap.
    if (inventory.gaps.length === 0 && inventory.counts.confirmed > 0) {
      const sourceId = `${projectId}:full-coverage`;
      validSourceIds.add(`presence-strength:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'presence-strength',
          sourceId,
          dimension: 'web-mentions',
          action: 'build',
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: `Full expected presence coverage for a ${inventory.assessment.businessProfileLabel} business`,
          description: `${inventory.counts.confirmed} confirmed account(s), no expected platform missing.`,
          severity: 'low',
        }),
      );
    }

    for (const review of inventory.reviews) {
      if (review.reviewCount == null || review.reviewCount < 5 || review.rating == null) continue;
      const sourceId = `${projectId}:${review.platform}`;
      if (review.rating < 3.5) {
        validSourceIds.add(`presence-review:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'presence-review',
            sourceId,
            dimension: 'web-mentions',
            action: 'influence',
            category: 'risk',
            recommendationCategory: 'reputation-strategy',
            impact: 4,
            effort: 3,
            title: `Low rating on ${review.platform} (${review.rating}/5, ${review.reviewCount} reviews)`,
            description: `A ${review.rating}/5 rating from ${review.reviewCount} reviews on ${review.platform} is visible to anyone researching this business before buying.`,
            severity: 'high',
          }),
        );
      } else if (review.rating >= 4.5 && review.reviewCount >= 20) {
        validSourceIds.add(`presence-strength:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'presence-strength',
            sourceId,
            dimension: 'web-mentions',
            action: 'influence',
            category: 'strength',
            recommendationCategory: null,
            impact: null,
            effort: null,
            title: `Strong rating on ${review.platform} (${review.rating}/5, ${review.reviewCount} reviews)`,
            description: `A ${review.rating}/5 rating from ${review.reviewCount} reviews is a real, checkable trust signal.`,
            severity: 'low',
          }),
        );
      }
    }
  }

  /**
   * Posting cadence per confirmed social account, from `PresencePost` rows
   * (`presence/social-activity`'s Apify pull) — a real signal this pipeline
   * already collected but never read anywhere downstream until now. Only
   * scoped accounts that have actually been scraped at least once (a post
   * row on file); an account nobody has pulled yet says nothing about its
   * cadence, so it is silently skipped rather than treated as "inactive."
   */
  private async syncSocialActivity(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const accounts = await this.prisma.presenceAccount.findMany({
      where: { projectId, state: 'confirmed', entity: { not: 'personal' } },
    });
    if (accounts.length === 0) return;

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const account of accounts) {
      const posts = await this.prisma.presencePost.findMany({
        where: { accountId: account.id, kind: 'post' },
        orderBy: { postedAt: 'desc' },
      });
      if (posts.length === 0) continue; // never scraped — silence, not a claim of inactivity

      const lastPostAt = posts.find((p) => p.postedAt)?.postedAt ?? null;
      const postsLast30d = posts.filter((p) => p.postedAt && now - p.postedAt.getTime() <= THIRTY_DAYS_MS).length;
      const label = PLATFORM_LABELS[account.platform as keyof typeof PLATFORM_LABELS] ?? account.platform;
      const sourceId = `${projectId}:${account.platform}`;

      if (postsLast30d === 0) {
        const daysSince = lastPostAt ? Math.floor((now - lastPostAt.getTime()) / (24 * 60 * 60 * 1000)) : null;
        const severity = daysSince === null || daysSince > 90 ? 'high' : daysSince > 30 ? 'medium' : 'low';
        validSourceIds.add(`social-cadence:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'social-cadence',
            sourceId,
            dimension: 'web-mentions',
            action: 'build',
            category: 'issue',
            recommendationCategory: 'social-strategy',
            impact: severity === 'high' ? 4 : severity === 'medium' ? 3 : 2,
            effort: 2,
            title:
              daysSince === null
                ? `No posts found on ${label} in the scraped window`
                : `No posts on ${label} in the last 30 days (last post ${daysSince} day(s) ago)`,
            description: `Confirmed account, actively scraped (${posts.length} post(s) on file), but nothing in the last 30 days — a visitor or an AI answer engine reading this profile sees a dormant account.`,
            severity,
          }),
        );
      } else {
        validSourceIds.add(`social-cadence-strength:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'social-cadence-strength',
            sourceId,
            dimension: 'web-mentions',
            action: 'build',
            category: 'strength',
            recommendationCategory: null,
            impact: null,
            effort: null,
            title: `Active posting cadence on ${label}: ${postsLast30d} post(s) in the last 30 days`,
            description: `Confirmed account with recent activity — a visible, current presence rather than an abandoned profile.`,
            severity: 'low',
          }),
        );
      }
    }
  }

  // ── Source 6: tech-stack (missing category = issue/opportunity) ─────

  private async syncTechStack(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    // `TechStackScan` rows for a competitor's homepage are written under the
    // SAME projectId (CompetitorsService.buildProfile calls
    // `scanDomain(competitor.projectId, competitor.domain)`), so a bare
    // `{ projectId }` findFirst can pick up whichever domain was scanned
    // most recently — the client's, or a rival's if one was profiled after.
    // Filtering by the project's own domain (same pattern as
    // `TechStackService.getLatest`) is what keeps this the client's stack.
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { domain: true } });
    if (!project) return;
    const scan = await this.prisma.techStackScan.findFirst({
      where: { projectId, domain: project.domain },
      orderBy: { createdAt: 'desc' },
      include: { findings: true },
    });
    if (!scan || scan.status !== 'completed') return;

    const categoriesFound = new Set(scan.findings.map((f) => f.category));
    const checks: Array<{ category: string; key: string }> = [
      { category: 'analytics', key: 'no-analytics' },
      { category: 'crm', key: 'no-crm' },
      { category: 'chat', key: 'no-chat' },
      { category: 'ads', key: 'no-ads' },
    ];

    let missingAny = false;
    for (const check of checks) {
      const has = categoriesFound.has(check.category);
      if (has) continue;
      missingAny = true;
      const cls = classify('tech-stack-gap', check.key);
      if (!cls) continue;
      const sourceId = `${scan.id}:${check.key}`;
      validSourceIds.add(`tech-stack-gap:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'tech-stack-gap',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: cls.category,
          recommendationCategory: cls.recommendationCategory,
          impact: cls.impact,
          effort: cls.effort,
          title: cls.title,
          description: `No ${check.category} tool was detected on ${scan.domain} (scan ${scan.createdAt.toISOString().slice(0, 10)}). Deterministic signature match — absence here means "not detected", not "confirmed absent" if the tool loads only after user interaction.`,
          severity: check.category === 'analytics' ? 'high' : 'medium',
        }),
      );
    }

    if (!missingAny) {
      const cls = classify('tech-stack-strength', 'full-stack')!;
      const sourceId = `${scan.id}:full-stack`;
      validSourceIds.add(`tech-stack-strength:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'tech-stack-strength',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: cls.title,
          description: `Analytics, CRM, chat and ad-tracking signatures all detected on ${scan.domain}.`,
          severity: 'low',
        }),
      );
    }
  }

  // ── Source 7: competitors (presence/tech/schema deficits) ────────────

  private async syncCompetitors(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    // Unconfirmed candidates (status: 'candidate' — e.g. names an AEO answer
    // mentioned, not yet operator-reviewed) must not count as tracked
    // competitors here: this is what feeds the client-facing roadmap's
    // "no tracked competitor has X" claims, and the same roadmap separately
    // lists a missing-candidate's own platform as a gap to fix — counting it
    // as a competitor too puts both claims about the same entity in one report.
    const competitors = await this.prisma.competitor.findMany({
      where: { projectId, status: { not: 'candidate' } },
      include: { profiles: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (competitors.length === 0) return;

    const clientAccounts = await this.prisma.presenceAccount.findMany({
      where: { projectId, state: { not: 'candidate' }, entity: { not: 'personal' } },
      select: { platform: true },
    });
    const clientPlatforms = new Set(clientAccounts.map((a) => a.platform));

    // Same contamination risk as syncTechStack above — a competitor's
    // homepage scan shares this projectId, so this must be scoped to the
    // project's own domain or the "client vs. competitor" comparison below
    // can end up comparing a competitor against itself.
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { domain: true } });
    const clientTech = project
      ? await this.prisma.techStackScan.findFirst({
          where: { projectId, domain: project.domain },
          orderBy: { createdAt: 'desc' },
          include: { findings: true },
        })
      : null;
    const clientTechKeys = new Set((clientTech?.findings ?? []).map((f) => `${f.category}:${f.name}`));

    // platform/tech key -> names of competitors that have it, client doesn't
    const platformGaps = new Map<string, string[]>();
    const techGaps = new Map<string, string[]>();
    // platform/tech key -> true if the CLIENT has it and NO competitor does
    const clientPlatforms2 = new Set(clientPlatforms);
    const competitorHasPlatform = new Map<string, number>();
    const competitorHasTech = new Map<string, number>();

    for (const c of competitors) {
      // One malformed row (bad JSON in a stored profile) must not take down
      // every other competitor's contribution to this source — the outer
      // sync() try/catch is per-SOURCE, not per-competitor.
      try {
        const profile = c.profiles[0];
        if (!profile) continue;

        const rivalAccounts = profile.presenceAccounts ? (JSON.parse(profile.presenceAccounts) as Array<{ platform: string }>) : [];
        for (const a of rivalAccounts) {
          competitorHasPlatform.set(a.platform, (competitorHasPlatform.get(a.platform) ?? 0) + 1);
          if (!clientPlatforms2.has(a.platform)) {
            const names = platformGaps.get(a.platform) ?? [];
            names.push(c.name);
            platformGaps.set(a.platform, names);
          }
        }

        if (profile.techScanId) {
          const scan = await this.prisma.techStackScan.findUnique({ where: { id: profile.techScanId }, include: { findings: true } });
          for (const f of scan?.findings ?? []) {
            const key = `${f.category}:${f.name}`;
            competitorHasTech.set(key, (competitorHasTech.get(key) ?? 0) + 1);
            if (!clientTechKeys.has(key)) {
              const names = techGaps.get(key) ?? [];
              names.push(c.name);
              techGaps.set(key, names);
            }
          }
        }
      } catch (err) {
        this.logger.warn(`Gap sync: skipping competitor ${c.id} (${c.name}) — ${(err as Error).message}`);
      }
    }

    for (const [platform, names] of platformGaps) {
      const sourceId = `${projectId}:${platform}`;
      validSourceIds.add(`competitor-gap:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-gap',
          sourceId,
          dimension: 'web-mentions',
          action: 'build',
          category: 'gap',
          recommendationCategory: 'social-strategy',
          impact: names.length >= 2 ? 4 : 3,
          effort: 2,
          title: `${names.length === 1 ? names[0] : `${names.length} competitors`} on ${platform}, this site is not`,
          description: `Competitor(s) with a presence here: ${names.join(', ')}.`,
          severity: names.length >= 2 ? 'high' : 'medium',
        }),
      );
    }

    for (const [techKey, names] of techGaps) {
      const [category, name] = techKey.split(':');
      const sourceId = `${projectId}:${techKey}`;
      validSourceIds.add(`competitor-gap:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-gap',
          sourceId,
          dimension: 'demand',
          action: 'build',
          category: 'gap',
          recommendationCategory: 'technology-improvements',
          impact: 3,
          effort: 3,
          title: `${names.length === 1 ? names[0] : `${names.length} competitors`} use ${name} (${category}), this site does not`,
          description: `Competitor(s) using this: ${names.join(', ')}.`,
          severity: 'medium',
        }),
      );
    }

    // Client-only platforms/tech = strengths — something rivals haven't matched.
    for (const platform of clientPlatforms) {
      if (competitorHasPlatform.has(platform)) continue;
      const sourceId = `${projectId}:${platform}`;
      validSourceIds.add(`competitor-strength:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-strength',
          sourceId,
          dimension: 'web-mentions',
          action: 'build',
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: `Presence on ${platform} that no tracked competitor has`,
          description: `None of the ${competitors.length} tracked competitor(s) have a confirmed presence on ${platform}.`,
          severity: 'low',
        }),
      );
    }

    await this.syncCompetitorSeo(analysisId, projectId, competitors, validSourceIds, bump);
    await this.syncCompetitorReviews(analysisId, projectId, competitors, validSourceIds, bump);
  }

  /**
   * Stage 7 "Competitor SEO"/"Competitor Content" vs the client. Reads
   * `CompetitorProfile.seoScore` (homepage-only, `seo-rubric.ts`) against the
   * client's own latest `technical-audit` run's **average** page score — the
   * two are not the same methodology (homepage-only vs site-wide average),
   * so that difference is disclosed in every gap/strength this produces
   * rather than presented as an apples-to-apples number. No live fetch: both
   * sides are already-stored data (`competitors`'s own `/gap` endpoint reads
   * a fresh client homepage score instead, which is why gap-analysis does
   * not call it — see gap-analysis.module.ts).
   */
  private async syncCompetitorSeo(
    analysisId: string,
    projectId: string,
    competitors: Array<{ id: string; name: string; profiles: Array<{ seoScore: number | null; seoStatus: string }> }>,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const audit = await this.prisma.technicalAudit.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { pages: true },
    });
    if (!audit || audit.pages.length === 0) return;

    const ok = audit.pages.filter((p) => {
      try {
        return !(JSON.parse(p.issues || '[]') as string[]).includes('page-error');
      } catch {
        return true;
      }
    });
    if (ok.length === 0) return;
    const clientAvgScore = Math.round(ok.reduce((s, p) => s + (p.score ?? 0), 0) / ok.length);

    const SEO_GAP_THRESHOLD = 15; // meaningfully ahead, not noise
    let strongestAhead: { name: string; score: number } | null = null;
    let strongestBehind: { name: string; score: number } | null = null;

    for (const c of competitors) {
      const profile = c.profiles[0];
      if (!profile || profile.seoScore == null) continue;
      const delta = profile.seoScore - clientAvgScore;
      if (delta >= SEO_GAP_THRESHOLD && (!strongestAhead || profile.seoScore > strongestAhead.score)) {
        strongestAhead = { name: c.name, score: profile.seoScore };
      } else if (-delta >= SEO_GAP_THRESHOLD && (!strongestBehind || profile.seoScore < strongestBehind.score)) {
        strongestBehind = { name: c.name, score: profile.seoScore };
      }
    }

    if (strongestAhead) {
      const cls = classify('competitor-seo-gap', 'seo-ahead')!;
      const sourceId = `${projectId}:seo-ahead`;
      validSourceIds.add(`competitor-seo-gap:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-seo-gap',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: cls.category,
          recommendationCategory: cls.recommendationCategory,
          impact: cls.impact,
          effort: cls.effort,
          title: `${cls.title}: ${strongestAhead.name} (${strongestAhead.score}/100 vs this site's ${clientAvgScore}/100 average)`,
          description: `${strongestAhead.name}'s homepage scores ${strongestAhead.score}/100 on the same on-page SEO rubric (\`seo-rubric.ts\`) this site's pages are scored by. This site's average across ${ok.length} crawled pages is ${clientAvgScore}/100 — homepage-only vs site-wide average, not a like-for-like number, but a ${SEO_GAP_THRESHOLD}+ point gap is worth a look.`,
          severity: 'medium',
        }),
      );
    }

    if (strongestBehind) {
      const cls = classify('competitor-seo-strength', 'seo-ahead-client')!;
      const sourceId = `${projectId}:seo-ahead-client`;
      validSourceIds.add(`competitor-seo-strength:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-seo-strength',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: `${cls.title}: ${strongestBehind.name} (${strongestBehind.score}/100 vs this site's ${clientAvgScore}/100 average)`,
          description: `This site's average on-page SEO score (${clientAvgScore}/100 across ${ok.length} pages) beats ${strongestBehind.name}'s homepage score (${strongestBehind.score}/100) on the same rubric.`,
          severity: 'low',
        }),
      );
    }
  }

  /**
   * Stage 7 "Competitor Reviews" vs the client. Reads `PresenceReview` (the
   * client's own already-stored ratings — `digital-presence`, no fresh
   * lookup) against `CompetitorProfile.reviewRatings` per platform.
   */
  private async syncCompetitorReviews(
    analysisId: string,
    projectId: string,
    competitors: Array<{ id: string; name: string; profiles: Array<{ reviewRatings: string; reviewStatus: string }> }>,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const clientRows = await this.prisma.presenceReview.findMany({ where: { projectId }, orderBy: { fetchedAt: 'desc' } });
    const clientRatingByPlatform = new Map<string, number>();
    for (const r of clientRows) {
      if (r.rating == null || clientRatingByPlatform.has(r.platform)) continue; // first = latest, orderBy desc
      clientRatingByPlatform.set(r.platform, r.rating);
    }

    // platform -> competitor names with a published rating there, client absent
    const noReviewGaps = new Map<string, string[]>();
    // platform -> the single highest-rated competitor beating the client's own rating
    const lowerRatingRisk = new Map<string, { name: string; rating: number }>();
    // platform -> true if every competitor with data on it rates below the client
    const platformsWithCompetitorData = new Set<string>();
    const platformBeatsAll = new Map<string, boolean>();

    for (const c of competitors) {
      const profile = c.profiles[0];
      if (!profile) continue;
      let ratings: Array<{ platform: string; rating: number | null; found: boolean }> = [];
      try {
        ratings = JSON.parse(profile.reviewRatings || '[]');
      } catch {
        continue;
      }
      for (const r of ratings) {
        if (!r.found || r.rating == null) continue;
        platformsWithCompetitorData.add(r.platform);
        const clientRating = clientRatingByPlatform.get(r.platform);
        if (clientRating == null) {
          const names = noReviewGaps.get(r.platform) ?? [];
          names.push(c.name);
          noReviewGaps.set(r.platform, names);
          platformBeatsAll.set(r.platform, false);
          continue;
        }
        if (!platformBeatsAll.has(r.platform)) platformBeatsAll.set(r.platform, true);
        if (r.rating > clientRating) {
          platformBeatsAll.set(r.platform, false);
          const current = lowerRatingRisk.get(r.platform);
          if (!current || r.rating > current.rating) lowerRatingRisk.set(r.platform, { name: c.name, rating: r.rating });
        }
      }
    }

    for (const [platform, names] of noReviewGaps) {
      const cls = classify('competitor-review-gap', 'no-reviews')!;
      const sourceId = `${projectId}:${platform}`;
      validSourceIds.add(`competitor-review-gap:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-review-gap',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: cls.category,
          recommendationCategory: cls.recommendationCategory,
          impact: cls.impact,
          effort: cls.effort,
          title: `${cls.title} on ${platform}: ${names.length === 1 ? names[0] : `${names.length} competitors`}`,
          description: `Competitor(s) with a published rating on ${platform}: ${names.join(', ')}. This site has none recorded there.`,
          severity: names.length >= 2 ? 'high' : 'medium',
        }),
      );
    }

    for (const [platform, rival] of lowerRatingRisk) {
      const cls = classify('competitor-review-risk', 'lower-rating')!;
      const sourceId = `${projectId}:${platform}`;
      validSourceIds.add(`competitor-review-risk:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-review-risk',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: cls.category,
          recommendationCategory: cls.recommendationCategory,
          impact: cls.impact,
          effort: cls.effort,
          title: `${cls.title} on ${platform}: ${rival.name} (${rival.rating} vs this site's ${clientRatingByPlatform.get(platform)})`,
          description: `${rival.name} rates ${rival.rating} on ${platform}; this site rates ${clientRatingByPlatform.get(platform)} there.`,
          severity: 'medium',
        }),
      );
    }

    for (const [platform, rating] of clientRatingByPlatform) {
      if (!platformsWithCompetitorData.has(platform)) continue; // no rival data to compare against — not a claim either way
      if (platformBeatsAll.get(platform) !== true) continue;
      const cls = classify('competitor-review-strength', 'higher-rating')!;
      const sourceId = `${projectId}:${platform}`;
      validSourceIds.add(`competitor-review-strength:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'competitor-review-strength',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: `${cls.title} on ${platform} (${rating})`,
          description: `Rated ${rating} on ${platform}, ahead of every tracked competitor with a published rating there.`,
          severity: 'low',
        }),
      );
    }
  }

  // ── Source 8: serp-intelligence (rank gaps, AI Overview, local pack) ──

  private async syncSerpIntelligence(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const trackers = await this.prisma.serpTracker.findMany({ where: { projectId }, select: { id: true } });
    if (trackers.length === 0) return;

    // Latest result per query only — a query's history is not this stage's
    // concern, only its current state.
    const results = await this.prisma.serpResult.findMany({
      where: { snapshot: { trackerId: { in: trackers.map((t) => t.id) } } },
      orderBy: { capturedAt: 'desc' },
      include: { query: { select: { id: true, keyword: true } } },
    });
    const latestByQuery = new Map<string, (typeof results)[number]>();
    for (const r of results) {
      if (!r.query) continue;
      if (!latestByQuery.has(r.query.id)) latestByQuery.set(r.query.id, r);
    }

    for (const r of latestByQuery.values()) {
      const keyword = r.query!.keyword;

      if (r.subjectRank == null) {
        const cls = classify('serp-gap', 'no-rank')!;
        const sourceId = `${r.queryId}:no-rank`;
        validSourceIds.add(`serp-gap:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'serp-gap',
            sourceId,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title}: "${keyword}"`,
            description: `No organic result for this site in the first page tracked for "${keyword}" (captured ${r.capturedAt.toISOString().slice(0, 10)}).`,
            severity: 'medium',
          }),
        );
      } else if (r.subjectRank <= 3) {
        const cls = classify('serp-strength', 'strong-rank')!;
        const sourceId = `${r.queryId}:strong-rank`;
        validSourceIds.add(`serp-strength:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'serp-strength',
            sourceId,
            dimension: cls.dimension,
            action: cls.action,
            category: 'strength',
            recommendationCategory: null,
            impact: null,
            effort: null,
            title: `${cls.title}: "${keyword}" (rank ${r.subjectRank})`,
            description: `Rank ${r.subjectRank} for "${keyword}" as of ${r.capturedAt.toISOString().slice(0, 10)}.`,
            severity: 'low',
          }),
        );
      }

      if (r.aiOverviewPresent && !r.aiOverviewMentionsSubject) {
        const cls = classify('serp-gap', 'ai-overview-miss')!;
        const sourceId = `${r.queryId}:ai-overview-miss`;
        validSourceIds.add(`serp-gap:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'serp-gap',
            sourceId,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title}: "${keyword}"`,
            description: `Google shows an AI Overview for "${keyword}" that does not mention or cite this site.`,
            severity: 'medium',
          }),
        );
      }

      // Gated exactly as analyzeLocalPack() gates it — only when the client's
      // own business type made this a meaningful question in the first place.
      if (r.localPackApplicable && r.localPackPresent === false) {
        const cls = classify('serp-gap', 'local-pack-miss')!;
        const sourceId = `${r.queryId}:local-pack-miss`;
        validSourceIds.add(`serp-gap:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'serp-gap',
            sourceId,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title}: "${keyword}"`,
            description: `A local map pack appeared for "${keyword}" and did not include this business.`,
            severity: 'high',
          }),
        );
      } else if (r.localPackApplicable && r.localPackPresent === true && r.localPackRank != null && r.localPackRank <= 3) {
        const cls = classify('serp-strength', 'local-pack-strong')!;
        const sourceId = `${r.queryId}:local-pack-strong`;
        validSourceIds.add(`serp-strength:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'serp-strength',
            sourceId,
            dimension: cls.dimension,
            action: cls.action,
            category: 'strength',
            recommendationCategory: null,
            impact: null,
            effort: null,
            title: `${cls.title}: "${keyword}" (rank ${r.localPackRank})`,
            description: `Rank ${r.localPackRank} in the local pack for "${keyword}".`,
            severity: 'low',
          }),
        );
      }
    }
  }

  // ── Source 9: aeo-audit (mention rate, competitor standing, SOV) ─────

  private async syncAeoAudit(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    const audit = await this.prisma.aeoAudit.findFirst({
      where: { projectId, status: 'completed', verdict: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!audit?.verdict) return;

    let verdict: any;
    try {
      verdict = JSON.parse(audit.verdict);
    } catch {
      return;
    }
    const counted = verdict?.counted;
    if (!counted) return;

    const unbrandedRate = counted.unbranded?.mentionRate;
    if (typeof unbrandedRate === 'number' && unbrandedRate < 0.15) {
      const cls = classify('aeo-gap', 'low-mention-rate')!;
      const sourceId = `${audit.id}:low-mention-rate`;
      validSourceIds.add(`aeo-gap:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'aeo-gap',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: cls.category,
          recommendationCategory: cls.recommendationCategory,
          impact: cls.impact,
          effort: cls.effort,
          title: `${cls.title} (${Math.round(unbrandedRate * 100)}%)`,
          description: `Named in only ${Math.round(unbrandedRate * 100)}% of unbranded observations across measured answer engines (audit ${audit.id}).`,
          severity: 'high',
        }),
      );
    }

    const competitors: Array<{ name: string; clientAheadCount: number; clientBehindCount: number; wonWhileClientAbsent: number }> = counted.competitors ?? [];
    for (const c of competitors) {
      if (c.wonWhileClientAbsent > 0 && c.clientBehindCount > c.clientAheadCount) {
        const cls = classify('aeo-risk', 'losing-to-competitor')!;
        const sourceId = `${audit.id}:${c.name}`;
        validSourceIds.add(`aeo-risk:${sourceId}`);
        bump(
          await this.upsertGap(analysisId, {
            sourceType: 'aeo-risk',
            sourceId,
            dimension: cls.dimension,
            action: cls.action,
            category: cls.category,
            recommendationCategory: cls.recommendationCategory,
            impact: cls.impact,
            effort: cls.effort,
            title: `${cls.title}: ${c.name}`,
            description: `${c.name} was named ahead of this site ${c.clientBehindCount} time(s) and named while this site was absent ${c.wonWhileClientAbsent} time(s).`,
            severity: 'high',
          }),
        );
      }
    }

    // `shareOfVoice` is ordered client-first, ALWAYS (measurement.service.ts:
    // "{ name: project.name + ' (you)', share }" is pushed before every
    // competitor, never sorted by share) — sov[0] is never a signal of who
    // leads. The client's own row is the one ending "(you)" (same convention
    // `scoring.service.ts` reads it by); it only leads when its share is
    // strictly the highest of every row measured.
    const sov: Array<{ name: string; share: number }> = counted.shareOfVoice ?? [];
    const clientRow = sov.find((s) => s.name.endsWith('(you)'));
    const maxShare = sov.length > 0 ? Math.max(...sov.map((s) => s.share)) : 0;
    if (sov.length > 1 && clientRow && clientRow.share > 0 && clientRow.share >= maxShare) {
      const cls = classify('aeo-strength', 'sov-leader')!;
      const sourceId = `${audit.id}:sov-leader`;
      validSourceIds.add(`aeo-strength:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'aeo-strength',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: 'strength',
          recommendationCategory: null,
          impact: null,
          effort: null,
          title: `${cls.title} (${Math.round(clientRow.share * 100)}% share)`,
          description: `Leads share of voice at ${Math.round(clientRow.share * 100)}% across measured answer engines (audit ${audit.id}).`,
          severity: 'low',
        }),
      );
    }

    // Stage 6 "Competitors by Area / Market". Only fires on a genuinely
    // multi-market audit — on a single-market run this array's one entry
    // carries the same standings as `counted.competitors` above (see
    // MarketCompetitorStandings' own doc comment), so firing here too would
    // just duplicate the aeo-risk row already created.
    const byMarketCompetitors: Array<{
      market: string;
      competitors: Array<{ name: string; clientAheadCount: number; clientBehindCount: number; wonWhileClientAbsent: number }>;
    }> = counted.byMarketCompetitors ?? [];
    if (byMarketCompetitors.length > 1) {
      for (const marketRow of byMarketCompetitors) {
        for (const c of marketRow.competitors) {
          if (c.wonWhileClientAbsent > 0 && c.clientBehindCount > c.clientAheadCount) {
            const cls = classify('market-competitor-risk', 'losing-in-market')!;
            const sourceId = `${audit.id}:${marketRow.market}:${c.name}`;
            validSourceIds.add(`market-competitor-risk:${sourceId}`);
            bump(
              await this.upsertGap(analysisId, {
                sourceType: 'market-competitor-risk',
                sourceId,
                dimension: cls.dimension,
                action: cls.action,
                category: cls.category,
                recommendationCategory: cls.recommendationCategory,
                impact: cls.impact,
                effort: cls.effort,
                title: `${cls.title} in ${marketRow.market}: ${c.name}`,
                description: `In the ${marketRow.market} market, ${c.name} was named ahead of this site ${c.clientBehindCount} time(s) and named while this site was absent ${c.wonWhileClientAbsent} time(s) (audit ${audit.id}).`,
                severity: 'high',
              }),
            );
          }
        }
      }
    }
  }

  // ── Source 10: keyword-research (stage 10 "Select Priority Keywords") ──

  private async syncKeywordOpportunities(
    analysisId: string,
    projectId: string,
    validSourceIds: Set<string>,
    bump: (r: { created: boolean }) => void,
  ): Promise<void> {
    // Pure read + compute, no vendor call — see gap-analysis.module.ts for
    // why this is the one other service (besides PresenceService) this
    // module is allowed to inject.
    let priority: Awaited<ReturnType<KeywordResearchService['priority']>>;
    try {
      priority = await this.keywordResearch.priority(projectId, {});
    } catch {
      return; // no keyword set run yet for this project — nothing to surface
    }

    const PRIORITY_THRESHOLD = 50;
    const TOP_N = 10; // a report-worthy shortlist, not every keyword above the bar
    const top = priority.keywords.filter((k) => k.priorityScore >= PRIORITY_THRESHOLD).slice(0, TOP_N);

    for (const k of top) {
      const cls = classify('keyword-opportunity', 'priority-keyword')!;
      const sourceId = `${priority.setId}:${k.id}`;
      validSourceIds.add(`keyword-opportunity:${sourceId}`);
      bump(
        await this.upsertGap(analysisId, {
          sourceType: 'keyword-opportunity',
          sourceId,
          dimension: cls.dimension,
          action: cls.action,
          category: cls.category,
          recommendationCategory: cls.recommendationCategory,
          impact: cls.impact,
          effort: cls.effort,
          title: `${cls.title}: "${k.keyword}" (priority ${k.priorityScore}/100, volume ${k.searchVolume ?? 'n/a'}/mo)`,
          description: `Search volume ${k.searchVolume ?? 'n/a'}/mo, competition ${k.competition ?? 'n/a'} (${k.competitionIndex ?? 'n/a'}/100), CPC $${k.cpc ?? 'n/a'} — ranked ${k.priorityScore}/100 on disclosed weights (keyword-research/priority).`,
          severity: k.priorityScore >= 75 ? 'high' : 'medium',
        }),
      );
    }
  }

  // ─── Upsert / patch ──────────────────────────────────────────────────

  private async upsertGap(gapAnalysisId: string, data: GapInput): Promise<{ created: boolean }> {
    const existing = await this.prisma.gap.findFirst({ where: { sourceType: data.sourceType, sourceId: data.sourceId } });
    const quadrant = computeQuadrant(data.impact, data.effort);

    if (existing) {
      const patch: any = {};
      if (existing.dimensionAutoAssigned) patch.dimension = data.dimension;
      if (existing.actionAutoAssigned) patch.action = data.action;
      if (existing.categoryAutoAssigned) {
        patch.category = data.category;
        patch.recommendationCategory = data.recommendationCategory;
      }
      // Decoupled from categoryAutoAssigned: an operator overriding impact/
      // effort said nothing about category, and vice versa — coupling them
      // meant a category-only override silently froze impact/effort forever,
      // and an impact/effort-only override never survived the next sync().
      if (existing.scoreAutoAssigned) {
        patch.impactScore = data.impact;
        patch.effortScore = data.effort;
        patch.quadrant = quadrant;
      }
      // Also decoupled: a title/description override (`copyAutoAssigned`)
      // used to ride on dimension/action/category's flags, so patching only
      // the copy never actually stuck — the very next sync() overwrote it
      // back to the auto-generated text.
      if (existing.copyAutoAssigned) {
        patch.title = data.title;
        patch.description = data.description;
        patch.severity = data.severity;
      }
      if (Object.keys(patch).length > 0) {
        await this.prisma.gap.update({ where: { id: existing.id }, data: patch });
      }
      return { created: false };
    }

    await this.prisma.gap.create({
      data: {
        gapAnalysisId,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        dimension: data.dimension,
        dimensionAutoAssigned: true,
        action: data.action,
        actionAutoAssigned: true,
        category: data.category,
        categoryAutoAssigned: true,
        recommendationCategory: data.recommendationCategory,
        impactScore: data.impact,
        effortScore: data.effort,
        scoreAutoAssigned: true,
        quadrant,
        title: data.title,
        description: data.description,
        copyAutoAssigned: true,
        severity: data.severity,
        status: 'open',
      },
    });
    return { created: true };
  }

  /** Patch a gap: override dimension/action/category/status and set 1-5 priority inputs. */
  async patchGap(
    projectId: string,
    gapId: string,
    patch: {
      dimension?: string;
      action?: string;
      category?: string;
      status?: string;
      demandPotential?: number;
      credibilityImpact?: number;
      citationLikelihood?: number;
      impactScore?: number;
      effortScore?: number;
      title?: string;
      description?: string;
    },
  ) {
    const gap = await this.getGap(projectId, gapId);
    const data: any = {};
    if (patch.dimension !== undefined) {
      data.dimension = patch.dimension;
      data.dimensionAutoAssigned = false;
    }
    if (patch.action !== undefined) {
      data.action = patch.action;
      data.actionAutoAssigned = false;
    }
    if (patch.category !== undefined) {
      data.category = patch.category;
      data.categoryAutoAssigned = false;
    }
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.demandPotential !== undefined) data.demandPotential = patch.demandPotential;
    if (patch.credibilityImpact !== undefined) data.credibilityImpact = patch.credibilityImpact;
    if (patch.citationLikelihood !== undefined) data.citationLikelihood = patch.citationLikelihood;
    if (patch.title !== undefined) {
      data.title = patch.title;
      data.copyAutoAssigned = false;
    }
    if (patch.description !== undefined) {
      data.description = patch.description;
      data.copyAutoAssigned = false;
    }

    const demand = patch.demandPotential !== undefined ? patch.demandPotential : gap.demandPotential;
    const credibility = patch.credibilityImpact !== undefined ? patch.credibilityImpact : gap.credibilityImpact;
    const citation = patch.citationLikelihood !== undefined ? patch.citationLikelihood : gap.citationLikelihood;
    if (patch.demandPotential !== undefined || patch.credibilityImpact !== undefined || patch.citationLikelihood !== undefined) {
      data.priorityScore = computePriorityScore(demand as number | null, credibility as number | null, citation as number | null);
    }

    // An operator override of impact/effort recomputes the quadrant the same
    // way sync() would — the derivation stays the single source of truth —
    // and flips scoreAutoAssigned so the NEXT sync() doesn't silently revert it.
    if (patch.impactScore !== undefined || patch.effortScore !== undefined) {
      data.impactScore = patch.impactScore !== undefined ? patch.impactScore : gap.impactScore;
      data.effortScore = patch.effortScore !== undefined ? patch.effortScore : gap.effortScore;
      data.quadrant = computeQuadrant(data.impactScore, data.effortScore);
      data.scoreAutoAssigned = false;
    }

    const updated = await this.prisma.gap.update({ where: { id: gapId }, data });
    return updated;
  }

  /** Roadmap grouped by action, sorted by priorityScore desc (nulls last). */
  async getRoadmap(projectId: string) {
    const analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) return { projectId, groups: [], total: 0 };

    const gaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id } });

    const groups: Record<GapAction, typeof gaps> = { fix: [], build: [], influence: [] } as any;
    for (const gap of gaps) {
      const action = gap.action as GapAction;
      if (!groups[action]) (groups as any)[action] = [];
      (groups[action] as any).push(gap);
    }

    const sortByPriority = (a: any, b: any) => {
      if (a.priorityScore != null && b.priorityScore != null) return b.priorityScore - a.priorityScore;
      if (a.priorityScore != null) return -1;
      if (b.priorityScore != null) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    };

    const result = (Object.keys(groups) as GapAction[]).map((action) => {
      const sorted = [...(groups[action] || [])].sort(sortByPriority);
      return { action, gaps: sorted, count: sorted.length };
    });

    const order: GapAction[] = ['fix', 'build', 'influence'];
    result.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));

    return { projectId, groups: result, total: gaps.length };
  }
}
