/**
 * DTOs for Gap Analysis.
 *
 * @module gap-analysis.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsIn, IsInt, Min, Max, IsString, MaxLength } from 'class-validator';

export class PatchGapDto {
  @ApiPropertyOptional({ enum: ['visibility', 'narrative', 'topic', 'format', 'web-mentions', 'demand'] })
  @IsIn(['visibility', 'narrative', 'topic', 'format', 'web-mentions', 'demand'])
  @IsOptional()
  dimension?: string;

  @ApiPropertyOptional({ enum: ['fix', 'build', 'influence'] })
  @IsIn(['fix', 'build', 'influence'])
  @IsOptional()
  action?: string;

  @ApiPropertyOptional({ enum: ['open', 'in-progress', 'resolved'] })
  @IsIn(['open', 'in-progress', 'resolved'])
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Manual 1-5: demand potential', minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  demandPotential?: number;

  @ApiPropertyOptional({ description: 'Manual 1-5: credibility impact', minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  credibilityImpact?: number;

  @ApiPropertyOptional({ description: 'Manual 1-5: citation likelihood', minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  citationLikelihood?: number;

  @ApiPropertyOptional({ description: 'Optional override title' })
  @IsString()
  @IsOptional()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional({ description: 'Optional override description' })
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string;
}
