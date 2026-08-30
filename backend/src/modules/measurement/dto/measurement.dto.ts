/**
 * DTOs for the Measurement module.
 *
 * @module measurement.dto
 */

import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRunDto {
  @IsString()
  @MinLength(3)
  querySetId: string;

  @IsIn(['claude', 'perplexity', 'mock'])
  surface: string;

  /** Country code for geo-baselined runs (PRD FR-6.3: >= 2 geos per baseline). */
  @IsString()
  @IsOptional()
  @MaxLength(8)
  geo?: string;

  /** Repeats per prompt — hard floor of 5 (n≥5, no exceptions; validated again in service). */
  @IsInt()
  @Min(5)
  @Max(25)
  @IsOptional()
  runCount?: number;
}