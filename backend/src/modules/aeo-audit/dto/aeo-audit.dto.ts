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
