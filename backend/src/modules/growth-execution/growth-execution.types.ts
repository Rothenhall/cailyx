/**
 * Types for the Growth Execution module — stage 11, "Marketing & Growth
 * Execution" (12-stage delivery flow).
 *
 * @module growth-execution.types
 */

import type { RecommendationCategory } from '../gap-analysis/gap-analysis.types';

/** The flowchart's nine "Create Recommended Assets" leaves, exactly. */
export const ASSET_TYPES = [
  'article',
  'ad-copy',
  'social-content',
  'email-campaign',
  'landing-page',
  'structured-data',
  'seo-fix',
  'faq',
  'review-campaign',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  article: 'Article / Guide',
  'ad-copy': 'Ad Copy',
  'social-content': 'Social Content',
  'email-campaign': 'Email Campaign',
  'landing-page': 'Landing Page',
  'structured-data': 'Structured Data',
  'seo-fix': 'SEO Fix',
  faq: 'FAQ / Knowledge Content',
  'review-campaign': 'Review / Reputation Campaign',
};

/**
 * Where each stage-9 recommendation category feeds stage 11. Deliberately
 * NOT total: `technology-improvements` produces no content asset — a CRM
 * gap is not a blog post, and inventing one to fill the table would be
 * exactly the kind of fabricated coverage this codebase avoids elsewhere.
 */
export const CATEGORY_TO_ASSET_TYPES: Record<RecommendationCategory, AssetType[]> = {
  'seo-improvements': ['seo-fix'],
  'content-strategy': ['article', 'faq'],
  'social-strategy': ['social-content'],
  'reputation-strategy': ['review-campaign'],
  'search-aeo-strategy': ['structured-data'],
  'conversion-optimization': ['email-campaign'],
  'technology-improvements': [],
  'advertising-opportunities': ['ad-copy'],
  'market-expansion': ['landing-page'],
};

export type AssetStatus = 'recommended' | 'in-progress' | 'published';
export type AssetSource = 'deterministic' | 'generated-llm';

/** "Suggest Blog Topics & Ad Angles" — a preview, never persisted. */
export interface TopicSuggestionDto {
  targetKeyword: string;
  priorityScore: number;
  searchVolume: number | null;
  blogTopic: string;
  adAngle: string;
}

export interface FaqPair {
  question: string;
  answer: string;
}

/**
 * Real generated content for assetType "article" — GrowthAsset.content,
 * parsed. "Fully ready": SEO title, SEO meta description, a URL slug, the
 * full body (including its FAQ section), and ready-to-embed JSON-LD —
 * `BlogPosting` always, `FAQPage` when the article has FAQ pairs. The JSON-LD
 * blocks are built deterministically in code from the LLM's structured
 * fields (title/description/faq), never asked of the model directly — a
 * hand-built object is guaranteed valid schema.org markup; LLM-authored
 * JSON-LD is not.
 */
export interface ArticleContent {
  title: string;
  metaDescription: string;
  /** Lowercase-hyphenated, derived from title/keyword — a suggested path, not a live URL (the asset is pre-publish). */
  slug: string;
  /** Full article body, markdown (## headings), INCLUDING the rendered FAQ section. Real, publishable-draft-quality prose — not a brief. */
  bodyMarkdown: string;
  wordCount: number;
  faq: FaqPair[];
  /** Ready-to-embed JSON-LD blocks: [BlogPosting] or [BlogPosting, FAQPage]. */
  jsonLd: Record<string, unknown>[];
}

export interface AdCopyVariant {
  /** Google/Meta-style short headline. Not hard-truncated — the model is instructed on the target length, never silently cut. */
  headline: string;
  description: string;
}

/** Real generated content for assetType "ad-copy" — GrowthAsset.content, parsed. */
export interface AdCopyContent {
  variants: AdCopyVariant[];
}

export interface GrowthAssetDto {
  id: string;
  projectId: string;
  assetType: AssetType;
  title: string;
  brief: string;
  targetKeyword: string | null;
  sourceGapId: string | null;
  status: AssetStatus;
  source: AssetSource;
  generationModel: string | null;
  /** Real generated deliverable — ArticleContent for "article", AdCopyContent for "ad-copy". Null for every other asset type, and for article/ad-copy rows from before content generation existed. */
  content: ArticleContent | AdCopyContent | null;
  publishedAt: string | null;
  assetUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
