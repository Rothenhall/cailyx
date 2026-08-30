/**
 * DTOs for the QuerySet module (SOP-1, PRD FR-5).
 *
 * @module query-set.dto
 */

import { IsString, IsNotEmpty, IsOptional, IsIn, MaxLength, MinLength } from 'class-validator';

export class CreateQuerySetDto {
  @IsIn(['problem-aware', 'solution-aware', 'product-aware', 'most-aware'])
  persona: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  label?: string;

  @IsIn(['manual', 'sales-questions', 'support-tickets'])
  @IsOptional()
  source?: string;

  /** Optional first prompt to seed the draft with. */
  @IsString()
  @IsOptional()
  @MinLength(5)
  @MaxLength(500)
  prompt?: string;

  /** Funnel stage for the optional seed prompt (defaults to the persona). */
  @IsIn(['problem-aware', 'solution-aware', 'product-aware', 'most-aware'])
  @IsOptional()
  funnelStage?: string;
}

export class AddPromptDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  prompt: string;

  @IsIn(['problem-aware', 'solution-aware', 'product-aware', 'most-aware'])
  funnelStage: string;
}