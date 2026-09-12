/**
 * DTOs for the Keyword Research module.
 *
 * @module keyword-research.dto
 */

import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';

/** DataForSEO's own cap for `search_volume/live` is 1000/request; kept far below that. */
export const KEYWORD_RESEARCH_LIMITS = {
  maxKeywords: 200,
  maxKeywordLen: 80,
};

/**
 * Request body for POST /projects/:projectId/keyword-research
 */
export class RunKeywordResearchDto {
  /**
   * The seed keywords to research. Explicit input only in v1 — no automatic
   * derivation from `SiteContext.services` (see the module's LEFT-OUT.md).
   */
  @ApiProperty({
    description: 'Seed keywords to pull volume/competition/CPC for.',
    example: ['ai visibility platform', 'answer engine optimization'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(KEYWORD_RESEARCH_LIMITS.maxKeywords)
  @IsString({ each: true })
  @MaxLength(KEYWORD_RESEARCH_LIMITS.maxKeywordLen, { each: true })
  keywords: string[];

  @ApiPropertyOptional({
    description: 'DataForSEO location name. Defaults to "United States".',
    example: 'United States',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  locationName?: string;

  @ApiPropertyOptional({
    description: 'DataForSEO language code. Defaults to "en".',
    example: 'en',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  languageCode?: string;

  @ApiPropertyOptional({
    description:
      'Also pull related/long-tail keyword suggestions for the seeds (one extra vendor call, capped at the first 20 seeds — a DataForSEO limit on that endpoint). Defaults to true.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  includeRelated?: boolean;
}

/**
 * Query params for GET /projects/:projectId/keyword-research
 */
export class ListKeywordSetsQueryDto {
  @ApiPropertyOptional({ description: 'Return only this keyword set (with its keywords).' })
  @IsOptional()
  @IsString()
  setId?: string;

  @ApiPropertyOptional({ description: 'Only include keywords with searchVolume >= this value.' })
  @Type(() => Number) // query params arrive as strings — coerce before @IsInt
  @IsOptional()
  @IsInt()
  @Min(0)
  minVolume?: number;
}
