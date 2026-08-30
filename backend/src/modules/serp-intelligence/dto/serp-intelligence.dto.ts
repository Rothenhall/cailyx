/**
 * DTOs for the SERP Intelligence module (Agent #3, Swarm layer).
 *
 * @module serp-intelligence.dto
 */

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SERP_LIMITS } from '../serp-intelligence.types';

export class CreateTrackerDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name: string;

  @IsArray()
  @ArrayMinSize(SERP_LIMITS.keywordsPerTracker.min)
  @ArrayMaxSize(SERP_LIMITS.keywordsPerTracker.max)
  @IsString({ each: true })
  @MaxLength(SERP_LIMITS.maxKeywordLen, { each: true })
  keywords: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  locationName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  languageCode?: string;

  @IsOptional()
  @IsIn(['desktop', 'mobile'])
  device?: string;

  @IsOptional()
  @IsIn(['dataforseo', 'fixture'])
  provider?: string;
}

export class AddQueriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SERP_LIMITS.keywordsPerTracker.max)
  @IsString({ each: true })
  @MaxLength(SERP_LIMITS.maxKeywordLen, { each: true })
  keywords: string[];
}

export class CaptureDto {
  @IsOptional()
  @IsIn(['dataforseo', 'fixture'])
  provider?: string;
}
