/**
 * DTOs for the Opportunities module (P07).
 *
 * @module opportunities.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { ASSET_TYPES, type AssetType } from '../../growth-execution/growth-execution.types';
import { OPPORTUNITY_ORIGINS, type OpportunityOrigin, type OpportunityStatus } from '../opportunities.types';

export class AnalyzeOpportunitiesDto {
  @ApiPropertyOptional({ description: 'Restrict to one KeywordSet.id for the topic-suggestion pass. Defaults to the project\'s most recent completed/partial set.' })
  @IsOptional()
  @IsString()
  keywordSetId?: string;

  @ApiPropertyOptional({
    description: 'Minimum rank-position margin (client rank minus rival rank) to count as a "below rival by a meaningful margin" gap. Default 5.',
    default: 5,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  marginThreshold?: number;
}

export class ListOpportunitiesQueryDto {
  @ApiPropertyOptional({ enum: ['new', 'in-progress', 'dismissed', 'converted'] })
  @IsOptional()
  @IsIn(['new', 'in-progress', 'dismissed', 'converted'])
  status?: OpportunityStatus;

  @ApiPropertyOptional({ enum: OPPORTUNITY_ORIGINS })
  @IsOptional()
  @IsIn(OPPORTUNITY_ORIGINS)
  origin?: OpportunityOrigin;

  @ApiPropertyOptional({ description: 'Case-insensitive substring match against topicDisplay.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class DismissOpportunityDto {
  @ApiProperty({ description: 'Required. Re-running analysis with unchanged evidence must never silently reopen a dismissal made without one.' })
  @IsString()
  @MinLength(3)
  reason: string;
}

/** Reopen a dismissed opportunity — also requires a reason (a fresh one, not the analysis engine). */
export class ReopenOpportunityDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  reason: string;
}

export class ConvertOpportunityDto {
  @ApiProperty({ description: 'Client-generated idempotency key. A retried call with the same key never creates a second brief.' })
  @IsString()
  @MinLength(8)
  idempotencyKey: string;

  @ApiPropertyOptional({ enum: ASSET_TYPES, default: 'article' })
  @IsOptional()
  @IsIn(ASSET_TYPES)
  assetType?: AssetType;
}

export class ResearchTermDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  keyword: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  languageCode?: string;
}
