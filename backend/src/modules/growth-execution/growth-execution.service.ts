/**
 * Growth Execution Service — stage 11, "Marketing & Growth Execution".
 *
 * "Suggest Blog Topics & Ad Angles": reads stage 10's priority keywords
 * (`keyword-research.priority()`, a pure read) and turns each into a topic
 * + ad-angle pair. Preview only — never persisted, matching the flowchart's
 * "Suggest" verb rather than "Create".
 *
 * "Create Recommended Assets": reads stage 8's open, actionable gaps
 * (`gap-analysis`) grouped by their stage-9 recommendation category, and
 * generates one BRIEF per gap × mapped asset type (`CATEGORY_TO_ASSET_TYPES`)
 * — a title + angle a content/ad team acts on, not finished long-form copy.
 * Deterministic by default; `useLlm: true` refines each brief with one
 * constrained call via the shared `LlmService` (OpenRouter preferred,
 * Anthropic fallback — see `common/llm/llm.service.ts`), same opt-in shape
 * as `persona`/`journey`, gated on a configured provider with an honest 503
 * before anything is written.
 *
 * Never triggers gap-analysis to re-sync or keyword-research to pull fresh
 * vendor data — both are read-only inputs here, same discipline
 * `gap-analysis.module.ts` documents for its own sources.
 *
 * @module growth-execution.service
 */

import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../common/llm/llm.service';
import { PrismaService } from '../database/prisma.service';
import { GapAnalysisService } from '../gap-analysis/gap-analysis.service';
import { KeywordResearchService } from '../keyword-research/keyword-research.service';
import type { RecommendationCategory } from '../gap-analysis/gap-analysis.types';
import {
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  CATEGORY_TO_ASSET_TYPES,
  type AssetType,
  type GrowthAssetDto,
  type TopicSuggestionDto,
  type ArticleContent,
  type AdCopyContent,
  type FaqPair,
} from './growth-execution.types';
import type { CreateAssetsDto, ListAssetsQueryDto, UpdateAssetStatusDto, GenerateContentDto } from './dto/growth-execution.dto';

/** Deterministic per-type hint — what the brief should tell the reader to actually do. */
const ASSET_TYPE_HINT: Record<AssetType, string> = {
  article: 'a guide-style article addressing this directly, built around the site\'s own priority keywords where relevant',
  'ad-copy': 'ad copy variants targeting the commercial-intent keywords this addresses',
  'social-content': 'a short social post series announcing or addressing this',
  'email-campaign': 'a nurture email addressing this conversion gap',
  'landing-page': 'a dedicated landing page targeting the market/segment this gap names',
  'structured-data': 'JSON-LD markup covering the relevant schema.org type for this',
  'seo-fix': 'the specific on-page change described above',
  faq: 'an FAQ entry answering the question implied by this gap, in plain language',
  'review-campaign': 'an outreach sequence requesting reviews on the affected platform(s)',
};

const TOP_KEYWORDS_FOR_TOPICS = 8;
const DEFAULT_PER_CATEGORY_LIMIT = 2;
/** Hard ceiling on candidates processed per call, LLM or not — bounds cost regardless of assetTypes × perCategoryLimit combination. */
const MAX_CANDIDATES_PER_CALL = 20;
/** Default number of priority-keyword topics to generate real content for — each is its own LLM call, so this bounds cost/time by default. */
const DEFAULT_CONTENT_LIMIT = 3;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

interface AssetCandidate {
  assetType: AssetType;
  title: string;
  brief: string;
  targetKeyword: string | null;
  sourceGapId: string | null;
  impact: number;
}

@Injectable()
export class GrowthExecutionService {
  private readonly logger = new Logger(GrowthExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly gapAnalysis: GapAnalysisService,
    private readonly keywordResearch: KeywordResearchService,
  ) {}

  // ─── "Suggest Blog Topics & Ad Angles" (preview, never persisted) ────

  async suggestTopics(projectId: string): Promise<TopicSuggestionDto[]> {
    await this.ensureProject(projectId);

    let priority: Awaited<ReturnType<KeywordResearchService['priority']>>;
    try {
      priority = await this.keywordResearch.priority(projectId, { limit: TOP_KEYWORDS_FOR_TOPICS });
    } catch {
      return []; // no keyword set run yet — nothing to suggest, not an error
    }

    return priority.keywords.map((k) => ({
      targetKeyword: k.keyword,
      priorityScore: k.priorityScore,
      searchVolume: k.searchVolume,
      blogTopic: this.blogTopicFor(k.keyword),
      adAngle: this.adAngleFor(k.keyword, k.cpc, k.competition),
    }));
  }

  private blogTopicFor(keyword: string): string {
    const cap = keyword.replace(/\b\w/g, (c) => c.toUpperCase());
    return `${cap}: A Practical Guide`;
  }

  private adAngleFor(keyword: string, cpc: number | null, competition: string | null): string {
    const intent = cpc != null && cpc >= 5 ? 'high commercial intent' : competition === 'LOW' ? 'low-competition opening' : 'awareness-stage';
    return `Target "${keyword}" — ${intent}. Lead with the outcome, not the feature.`;
  }

  // ─── "Create Recommended Assets" (persisted) ──────────────────────────

  async createAssets(projectId: string, dto: CreateAssetsDto): Promise<GrowthAssetDto[]> {
    const useLlm = dto.useLlm === true;
    if (useLlm && !this.llm.isAvailable()) {
      throw new ServiceUnavailableException(
        'No LLM provider configured (OPENROUTER_API_KEY or ANTHROPIC_API_KEY) — growth-execution LLM refinement unavailable (omit useLlm for the deterministic generator).',
      );
    }
    await this.ensureProject(projectId);

    const requestedTypes = new Set<AssetType>(dto.assetTypes && dto.assetTypes.length > 0 ? dto.assetTypes : [...ASSET_TYPES]);
    const perCategoryLimit = dto.perCategoryLimit ?? DEFAULT_PER_CATEGORY_LIMIT;

    const { gaps } = await this.gapAnalysis.listGaps(projectId, {});
    // Same actionability filter strategy.service.ts uses: a category-less or
    // strength row has nothing to act on, so it produces no asset.
    const actionable = gaps.filter((g: any) => g.recommendationCategory && g.category !== 'strength' && g.status === 'open');

    const byCategory = new Map<RecommendationCategory, any[]>();
    for (const g of actionable) {
      const cat = g.recommendationCategory as RecommendationCategory;
      const list = byCategory.get(cat) ?? [];
      list.push(g);
      byCategory.set(cat, list);
    }

    let candidates: AssetCandidate[] = [];
    for (const [category, categoryGaps] of byCategory) {
      const mappedTypes = CATEGORY_TO_ASSET_TYPES[category].filter((t) => requestedTypes.has(t));
      if (mappedTypes.length === 0) continue;

      const topGaps = [...categoryGaps]
        .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0))
        .slice(0, perCategoryLimit);

      for (const gap of topGaps) {
        for (const assetType of mappedTypes) {
          candidates.push({
            assetType,
            title: `${ASSET_TYPE_LABELS[assetType]}: ${gap.title}`,
            brief: `${gap.description} Recommended: ${ASSET_TYPE_HINT[assetType]}.`,
            targetKeyword: null,
            sourceGapId: gap.id,
            impact: gap.impactScore ?? 0,
          });
        }
      }
    }

    // Highest-impact candidates first, then bound to the hard cap — the cap
    // must win regardless of how many categories/types/gaps combined above.
    candidates.sort((a, b) => b.impact - a.impact);
    if (candidates.length > MAX_CANDIDATES_PER_CALL) {
      this.logger.log(`growth-execution: ${candidates.length} candidates built, capped to ${MAX_CANDIDATES_PER_CALL} for ${projectId}`);
      candidates = candidates.slice(0, MAX_CANDIDATES_PER_CALL);
    }

    // Best-effort keyword enrichment: attach unused priority keywords to
    // content-ish asset types in ranked order. A join by topical similarity
    // would need real NLP this module does not have — never guessed.
    if (requestedTypes.has('article') || requestedTypes.has('ad-copy') || requestedTypes.has('landing-page')) {
      const topics = await this.suggestTopics(projectId);
      let ti = 0;
      for (const c of candidates) {
        if ((c.assetType === 'article' || c.assetType === 'ad-copy' || c.assetType === 'landing-page') && ti < topics.length) {
          c.targetKeyword = topics[ti].targetKeyword;
          ti++;
        }
      }
    }

    const rows: GrowthAssetDto[] = [];
    for (const c of candidates) {
      let brief = c.brief;
      let title = c.title;
      let source: 'deterministic' | 'generated-llm' = 'deterministic';
      let generationModel: string | null = null;

      if (useLlm) {
        try {
          const refined = await this.refineWithLlm(c);
          title = refined.title;
          brief = refined.brief;
          source = 'generated-llm';
          generationModel = refined.model;
        } catch (err) {
          this.logger.warn(`growth-execution LLM refine failed for "${c.title}" — keeping deterministic brief: ${(err as Error).message}`);
        }
      }

      const row = await this.prisma.growthAsset.create({
        data: {
          projectId,
          assetType: c.assetType,
          title,
          brief,
          targetKeyword: c.targetKeyword,
          sourceGapId: c.sourceGapId,
          status: 'recommended',
          source,
          generationModel,
        },
      });
      rows.push(this.toDto(row));
    }

    this.logger.log(`growth-execution: ${rows.length} asset(s) created for ${projectId} (useLlm=${useLlm})`);
    return rows;
  }

  private async refineWithLlm(c: AssetCandidate): Promise<{ title: string; brief: string; model: string }> {
    const result = await this.llm.json(
      {
        purpose: 'growth-execution brief refinement',
        maxTokens: 400,
        openRouterModel: this.config.get<string>('GROWTH_EXECUTION_MODEL'),
        anthropicModel: this.config.get<string>('GROWTH_EXECUTION_ANTHROPIC_MODEL'),
        system:
          'You write short, punchy content-asset briefs for a marketing team. One sentence title, ' +
          'two to three sentence brief. Never invent facts not in the input — only sharpen the framing and angle. ' +
          'Respond with ONLY JSON matching: {"title":string,"brief":string}',
        user:
          `Asset type: ${ASSET_TYPE_LABELS[c.assetType]}\n` +
          `Deterministic title: ${c.title}\n` +
          `Deterministic brief: ${c.brief}` +
          (c.targetKeyword ? `\nTarget keyword: ${c.targetKeyword}` : ''),
      },
      (raw) => {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.title !== 'string' || obj.title.length < 3 || typeof obj.brief !== 'string' || obj.brief.length < 10) {
          throw new Error('Model returned an incomplete title/brief');
        }
        return { title: obj.title, brief: obj.brief };
      },
    );
    return { title: result.data.title, brief: result.data.brief, model: result.model };
  }

  // ─── Real content generation: article + ad-copy ───────────────────
  //
  // Everything above this point produces a BRIEF (title + 2-3 sentence
  // angle) — a to-do for a writer, not a deliverable. This section produces
  // the actual deliverable for the two content-bearing types, from stage
  // 10's priority keywords via `suggestTopics()` (the flowchart's "Suggest
  // Blog Topics & Ad Angles" → these two boxes under "Create Recommended
  // Assets"). Always uses the LLM — there is no meaningful deterministic
  // way to write real prose, so unlike `createAssets()` this has no
  // useLlm:false path; it 503s honestly instead of faking a "generator".

  /**
   * Generate real article and/or ad-copy content for the project's top
   * priority-keyword topics.
   * @throws ServiceUnavailableException no LLM provider configured.
   */
  async generateContent(projectId: string, dto: GenerateContentDto): Promise<GrowthAssetDto[]> {
    if (!this.llm.isAvailable()) {
      throw new ServiceUnavailableException(
        'No LLM provider configured (OPENROUTER_API_KEY or ANTHROPIC_API_KEY) — content generation needs a real writer model, there is no deterministic fallback.',
      );
    }
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const types = dto.assetTypes && dto.assetTypes.length > 0 ? dto.assetTypes : (['article', 'ad-copy'] as const);
    const limit = dto.limit ?? DEFAULT_CONTENT_LIMIT;
    const topics = (await this.suggestTopics(projectId)).slice(0, limit);

    const rows: GrowthAssetDto[] = [];
    for (const topic of topics) {
      if (types.includes('article')) {
        try {
          const article = await this.generateArticle(topic, project);
          const row = await this.prisma.growthAsset.create({
            data: {
              projectId,
              assetType: 'article',
              title: article.content.title,
              brief: article.content.metaDescription,
              targetKeyword: topic.targetKeyword,
              sourceGapId: null,
              status: 'recommended',
              source: 'generated-llm',
              generationModel: article.model,
              content: JSON.stringify(article.content),
            },
          });
          rows.push(this.toDto(row));
        } catch (err) {
          this.logger.warn(`article generation failed for "${topic.targetKeyword}": ${(err as Error).message}`);
        }
      }
      if (types.includes('ad-copy')) {
        try {
          const ad = await this.generateAdCopy(topic);
          const row = await this.prisma.growthAsset.create({
            data: {
              projectId,
              assetType: 'ad-copy',
              title: `Ad Copy: ${topic.targetKeyword}`,
              brief: topic.adAngle,
              targetKeyword: topic.targetKeyword,
              sourceGapId: null,
              status: 'recommended',
              source: 'generated-llm',
              generationModel: ad.model,
              content: JSON.stringify(ad.content),
            },
          });
          rows.push(this.toDto(row));
        } catch (err) {
          this.logger.warn(`ad-copy generation failed for "${topic.targetKeyword}": ${(err as Error).message}`);
        }
      }
    }

    this.logger.log(`growth-execution: ${rows.length} content asset(s) generated for ${projectId} from ${topics.length} topic(s)`);
    return rows;
  }

  /**
   * One full article: LLM supplies title/metaDescription/slug/body/faq as
   * structured fields; the JSON-LD blocks (BlogPosting, + FAQPage when the
   * article has FAQ pairs) are built HERE, deterministically, from those
   * fields — never asked of the model directly, so the markup is always
   * valid schema.org, never a hallucinated shape.
   */
  private async generateArticle(
    topic: TopicSuggestionDto,
    project: { name: string; domain: string; category: string | null },
  ): Promise<{ content: ArticleContent; model: string }> {
    const result = await this.llm.json(
      {
        purpose: 'growth-execution article generation',
        maxTokens: 4000,
        openRouterModel: this.config.get<string>('GROWTH_EXECUTION_ARTICLE_MODEL') ?? this.config.get<string>('GROWTH_EXECUTION_MODEL'),
        anthropicModel: this.config.get<string>('GROWTH_EXECUTION_ANTHROPIC_MODEL'),
        system:
          'You write publishable-draft-quality SEO blog articles for a B2B marketing team. Ground every claim ONLY in ' +
          'the business context given — never invent product features, prices, customer names, or statistics not provided. ' +
          'Output:\n' +
          '- title: SEO title, 50-60 characters, includes the target keyword naturally.\n' +
          '- metaDescription: 150-160 characters, includes the keyword and a concrete benefit.\n' +
          '- slug: lowercase-hyphenated, derived from the title.\n' +
          '- bodyMarkdown: 800-1200 words. An intro that states the reader\'s problem, 3-5 "## " subheadings covering ' +
          'the topic in depth, and a conclusion with a soft call to action. Do NOT include an FAQ section here — that ' +
          'goes in the separate "faq" field.\n' +
          '- faq: 3-4 genuinely useful question/answer pairs a reader would ask next, each answer 1-3 sentences.\n' +
          'Respond with ONLY JSON matching: {"title":string,"metaDescription":string,"slug":string,"bodyMarkdown":string,' +
          '"faq":[{"question":string,"answer":string}]}',
        user:
          `Business: ${project.name} (${project.domain})${project.category ? `, category: ${project.category}` : ''}\n` +
          `Blog topic: ${topic.blogTopic}\n` +
          `Target keyword: ${topic.targetKeyword}${topic.searchVolume != null ? ` (search volume ~${topic.searchVolume}/mo)` : ''}\n` +
          `Angle: ${topic.adAngle}`,
      },
      (raw) => this.validateArticleFields(raw),
    );

    const faq = result.data.faq;
    const faqSection =
      faq.length > 0
        ? '\n\n## Frequently Asked Questions\n\n' + faq.map((f) => `**${f.question}**\n\n${f.answer}`).join('\n\n')
        : '';
    const bodyMarkdown = result.data.bodyMarkdown + faqSection;
    const wordCount = bodyMarkdown.split(/\s+/).filter(Boolean).length;

    const now = new Date().toISOString();
    const jsonLd: Record<string, unknown>[] = [
      {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: result.data.title,
        description: result.data.metaDescription,
        datePublished: now,
        dateModified: now,
        author: { '@type': 'Organization', name: project.name },
        publisher: { '@type': 'Organization', name: project.name },
        // A suggested path for when this draft is actually published — the
        // asset is status:"recommended", not a live page, so this is not a
        // claim that the URL exists yet.
        mainEntityOfPage: { '@type': 'WebPage', '@id': `https://${project.domain}/blog/${result.data.slug}` },
        keywords: topic.targetKeyword,
      },
    ];
    if (faq.length > 0) {
      jsonLd.push({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      });
    }

    return {
      model: result.model,
      content: {
        title: result.data.title,
        metaDescription: result.data.metaDescription,
        slug: result.data.slug,
        bodyMarkdown,
        wordCount,
        faq,
        jsonLd,
      },
    };
  }

  private validateArticleFields(raw: unknown): { title: string; metaDescription: string; slug: string; bodyMarkdown: string; faq: FaqPair[] } {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.title !== 'string' || obj.title.length < 5) throw new Error('Model returned no usable title');
    if (typeof obj.metaDescription !== 'string' || obj.metaDescription.length < 20) throw new Error('Model returned no usable metaDescription');
    if (typeof obj.bodyMarkdown !== 'string' || obj.bodyMarkdown.split(/\s+/).filter(Boolean).length < 200) {
      throw new Error('Model returned a body too short to be a real article');
    }
    const slugSource = typeof obj.slug === 'string' && obj.slug.trim() ? obj.slug : obj.title;
    const slug = slugify(slugSource);
    const faqRaw = Array.isArray(obj.faq) ? obj.faq : [];
    const faq: FaqPair[] = faqRaw
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({ question: String(f.question ?? '').trim(), answer: String(f.answer ?? '').trim() }))
      .filter((f) => f.question.length > 0 && f.answer.length > 0);
    return { title: obj.title, metaDescription: obj.metaDescription, slug, bodyMarkdown: obj.bodyMarkdown, faq };
  }

  /** 3-4 ready-to-run ad variants (Google/Meta-style headline + description), distinct angles. */
  private async generateAdCopy(topic: TopicSuggestionDto): Promise<{ content: AdCopyContent; model: string }> {
    const result = await this.llm.json(
      {
        purpose: 'growth-execution ad copy generation',
        maxTokens: 700,
        openRouterModel: this.config.get<string>('GROWTH_EXECUTION_AD_MODEL') ?? this.config.get<string>('GROWTH_EXECUTION_MODEL'),
        anthropicModel: this.config.get<string>('GROWTH_EXECUTION_ANTHROPIC_MODEL'),
        system:
          'You write ready-to-run ad copy (Google/Meta search-ad style) for a B2B marketing team. Ground copy ONLY in ' +
          'the keyword and angle given — never invent prices, guarantees, or claims not provided. Produce exactly 4 ' +
          'variants with genuinely distinct angles (benefit-led, urgency, social-proof, direct-offer). Each headline ' +
          '<=30 characters. Each description <=90 characters, states a concrete benefit with an implicit call to action. ' +
          'Respond with ONLY JSON matching: {"variants":[{"headline":string,"description":string}]}',
        user: `Target keyword: ${topic.targetKeyword}${topic.searchVolume != null ? ` (search volume ~${topic.searchVolume}/mo)` : ''}\nAngle: ${topic.adAngle}`,
      },
      (raw) => {
        const arr = (raw as { variants?: unknown }).variants;
        if (!Array.isArray(arr) || arr.length === 0) throw new Error('Model returned no ad variants');
        const variants = arr
          .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
          .map((v) => ({ headline: String(v.headline ?? '').trim(), description: String(v.description ?? '').trim() }))
          .filter((v) => v.headline.length > 0 && v.description.length > 0);
        if (variants.length === 0) throw new Error('Model returned no usable ad variants');
        return { variants };
      },
    );
    return { content: result.data, model: result.model };
  }

  // ─── List / status ─────────────────────────────────────────────────

  async list(projectId: string, query: ListAssetsQueryDto): Promise<{ assets: GrowthAssetDto[] }> {
    await this.ensureProject(projectId);
    const where: any = { projectId };
    if (query.assetType) where.assetType = query.assetType;
    if (query.status) where.status = query.status;
    const rows = await this.prisma.growthAsset.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { assets: rows.map((r) => this.toDto(r)) };
  }

  async updateStatus(projectId: string, assetId: string, dto: UpdateAssetStatusDto): Promise<GrowthAssetDto> {
    const existing = await this.prisma.growthAsset.findUnique({ where: { id: assetId } });
    if (!existing || existing.projectId !== projectId) {
      throw new NotFoundException(`Growth asset ${assetId} not found for project ${projectId}`);
    }
    const row = await this.prisma.growthAsset.update({
      where: { id: assetId },
      data: {
        status: dto.status,
        assetUrl: dto.assetUrl ?? existing.assetUrl,
        publishedAt: dto.status === 'published' && !existing.publishedAt ? new Date() : existing.publishedAt,
      },
    });
    return this.toDto(row);
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private async ensureProject(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  private toDto(row: {
    id: string;
    projectId: string;
    assetType: string;
    title: string;
    brief: string;
    targetKeyword: string | null;
    sourceGapId: string | null;
    status: string;
    source: string;
    generationModel: string | null;
    content: string | null;
    publishedAt: Date | null;
    assetUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): GrowthAssetDto {
    let content: ArticleContent | AdCopyContent | null = null;
    if (row.content) {
      try {
        content = JSON.parse(row.content) as ArticleContent | AdCopyContent;
      } catch {
        content = null;
      }
    }
    return {
      id: row.id,
      projectId: row.projectId,
      assetType: row.assetType as AssetType,
      title: row.title,
      brief: row.brief,
      targetKeyword: row.targetKeyword,
      sourceGapId: row.sourceGapId,
      status: row.status as GrowthAssetDto['status'],
      source: row.source as GrowthAssetDto['source'],
      generationModel: row.generationModel,
      content,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      assetUrl: row.assetUrl,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
