/**
 * DTOs for the AEO Audit module.
 *
 * @module aeo-audit.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AEO_SURFACES, MATRIX_TIERS, PROMPT_DIMENSIONS } from '../aeo-audit.types';

/** Build a fresh site context for a project. */
export class BuildContextDto {
  @ApiPropertyOptional({ description: 'Page ceiling for the crawl', default: 12, minimum: 1, maximum: 30 })
  @IsInt()
  @Min(1)
  @Max(30)
  @IsOptional()
  maxPages?: number;

  @ApiPropertyOptional({
    description: 'Run the LLM synthesis pass (services / ICP / pains / outcomes). Ignored without ANTHROPIC_API_KEY.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  refine?: boolean;

  @ApiPropertyOptional({ description: 'Fetch/request budget for the whole run (sitemap reads count too)', default: 40, minimum: 1, maximum: 200 })
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  maxRequests?: number;

  @ApiPropertyOptional({ description: 'Character budget across all LLM extraction batches', default: 24000, minimum: 1000, maximum: 200000 })
  @IsInt()
  @Min(1000)
  @Max(200000)
  @IsOptional()
  maxChars?: number;

  @ApiPropertyOptional({ description: 'Elapsed wall-time budget in ms before the run pauses (resumable)', default: 300000, minimum: 5000, maximum: 900000 })
  @IsInt()
  @Min(5000)
  @Max(900000)
  @IsOptional()
  maxElapsedMs?: number;

  @ApiPropertyOptional({
    description:
      'site-context-v2 Phase 2, spec §17 — search for a bounded set of fields (HQ, founding year, leadership, ' +
      'certifications, awards) when first-party extraction found none. Off by default: this spends real DataForSEO ' +
      'search credits, so it is only ever on when explicitly requested here.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  externalEnrichment?: boolean;

  @ApiPropertyOptional({
    description:
      'site-context-v2 Phase 2, spec §15–16 — trigger the digital-presence module\'s existing SERP-fallback ' +
      'discovery for any expected platform with no confirmed account yet. Off by default: real DataForSEO spend.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  socialDiscovery?: boolean;

  @ApiPropertyOptional({
    description:
      'site-context-v2 Phase 2, spec §19 — after consolidation, run one bounded search pass over only the fields ' +
      'consolidation flagged as missing, then refresh the summaries that changed. Off by default: real DataForSEO spend.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  gapResearch?: boolean;
}

/** Resume a paused/failed staged context run. */
export class ResumeContextRunDto {
  @ApiPropertyOptional({ description: 'Raise the elapsed-time budget before continuing (additive headroom, not a reset)', minimum: 5000, maximum: 900000 })
  @IsInt()
  @Min(5000)
  @Max(900000)
  @IsOptional()
  maxElapsedMs?: number;
}

/** Generate a prompt matrix from the project's latest (or a named) context. */
export class GenerateMatrixDto {
  @ApiPropertyOptional({
    description: 'Context to build from. Defaults to the project\'s latest stored context.',
  })
  @IsString()
  @IsOptional()
  contextId?: string;

  @ApiPropertyOptional({
    description:
      'Matrix size tier: trial=5, trial-wide=10, scorecard=25, standard=100, full=300 prompts. ' +
      'The trial tiers are smaller than the dimension count, so they cover only the heaviest-' +
      'weighted angles — the response reports the rest as skipped.',
    enum: MATRIX_TIERS as unknown as string[],
    default: 'standard',
  })
  @IsIn(MATRIX_TIERS as unknown as string[])
  @IsOptional()
  tier?: string;

  @ApiPropertyOptional({
    description: 'Rewrite template phrasing into natural buyer phrasing via LLM.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  refine?: boolean;

  @ApiPropertyOptional({
    description: 'Activate the set immediately so measurement can run it.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  activate?: boolean;
}

/** Start or run an audit end to end. */
export class RunAuditDto {
  @ApiPropertyOptional({
    description:
      'Single engine to measure. Ignored when `surfaces` is supplied. Every "-browser" engine is the ' +
      "vendor's consumer product driven in Playwright, and needs AEO_ALLOW_BROWSER_SURFACE=1 plus that " +
      "engine's own session file.",
    enum: AEO_SURFACES as unknown as string[],
    default: 'chatgpt-browser',
  })
  @IsIn(AEO_SURFACES as unknown as string[])
  @IsOptional()
  surface?: string;

  @ApiPropertyOptional({
    description:
      'Engines to measure with the SAME prompt matrix, so they can be compared directly. This is what ' +
      'produces findings like "named on Perplexity, invisible on ChatGPT". An engine that fails is ' +
      'reported with its reason and does not void the others.',
    enum: AEO_SURFACES as unknown as string[],
    isArray: true,
    example: ['chatgpt-browser', 'perplexity-browser', 'gemini-browser'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(AEO_SURFACES as unknown as string[], { each: true })
  @IsOptional()
  surfaces?: string[];

  @ApiPropertyOptional({ enum: MATRIX_TIERS as unknown as string[], default: 'standard' })
  @IsIn(MATRIX_TIERS as unknown as string[])
  @IsOptional()
  tier?: string;

  @ApiPropertyOptional({
    description: 'Repeats per prompt. Hard floor of 5 — n>=5, no exceptions.',
    default: 5,
    minimum: 5,
    maximum: 25,
  })
  @IsInt()
  @Min(5)
  @Max(25)
  @IsOptional()
  runCount?: number;

  @ApiPropertyOptional({ description: 'Country code recorded on the run, e.g. "IE".' })
  @IsString()
  @MaxLength(8)
  @IsOptional()
  geo?: string;

  @ApiPropertyOptional({
    description:
      'Explicit market override, ISO-3166 alpha-2 codes (wave-6 D8). Given, fans out surface × market ' +
      'immediately. Omitted, the default single market is derived from the site\'s own context.',
    example: ['US', 'GB'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(8, { each: true })
  @IsOptional()
  markets?: string[];

  @ApiPropertyOptional({ description: 'Reuse the latest stored context instead of re-scraping.', default: false })
  @IsBoolean()
  @IsOptional()
  reuseContext?: boolean;

  @ApiPropertyOptional({
    description: 'Skip the LLM stance pass. Counted metrics are produced either way.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  skipStance?: boolean;

  @ApiPropertyOptional({ description: 'Skip both LLM passes (context synthesis + matrix phrasing).', default: false })
  @IsBoolean()
  @IsOptional()
  skipRefine?: boolean;
}

/**
 * Query for the pre-flight budget estimate.
 *
 * Everything is optional so the workspace can ask "what would this cost?" while
 * the operator is still changing their mind, without a validation error for a
 * half-built configuration.
 */
export class BudgetQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated engines, e.g. "cloro-chatgpt,cloro-gemini".',
    example: 'cloro-chatgpt,cloro-perplexity,cloro-gemini',
  })
  @IsString()
  @IsOptional()
  surfaces?: string;

  @ApiPropertyOptional({ enum: MATRIX_TIERS as unknown as string[], default: 'trial' })
  @IsIn(MATRIX_TIERS as unknown as string[])
  @IsOptional()
  tier?: string;

  @ApiPropertyOptional({ description: 'Repeats per prompt (n>=5).', default: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(25)
  @IsOptional()
  runCount?: number;

  @ApiPropertyOptional({ description: 'How many markets the run covers.', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  markets?: number;
}

/** Filter a stored matrix by category. */
export class MatrixQueryDto {
  @ApiPropertyOptional({
    description: 'Return only prompts in this category.',
    enum: PROMPT_DIMENSIONS as unknown as string[],
  })
  @IsIn(PROMPT_DIMENSIONS as unknown as string[])
  @IsOptional()
  dimension?: string;
}

/** Query params for the merged AI-visibility read composition (summary/questions/history). */
export class VisibilityQueryDto {
  @ApiPropertyOptional({ description: 'Which audit to read. Defaults to the most recent completed audit.' })
  @IsString()
  @IsOptional()
  auditId?: string;

  @ApiPropertyOptional({
    description: 'Return only questions in this business topic.',
    enum: PROMPT_DIMENSIONS as unknown as string[],
  })
  @IsIn(PROMPT_DIMENSIONS as unknown as string[])
  @IsOptional()
  topic?: string;

  @ApiPropertyOptional({ description: 'Stable pagination cursor — the last question id from the previous page.' })
  @IsString()
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Page size (1-100).', default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

/** Response shape for the stance pass — documented for Swagger consumers. */
export class StancePassResponse {
  @ApiProperty({ description: 'Observations judged in this pass' })
  judged: number;

  @ApiProperty({ description: 'Observations already judged for this audit (left alone)' })
  skipped: number;

  @ApiProperty({ description: 'Observations the judge could not parse' })
  failed: number;

  @ApiProperty({ description: 'USD spent on this pass' })
  costUsd: number;

  @ApiProperty({ description: 'Model that produced the judgements' })
  judgeModel: string;
}
