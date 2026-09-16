/**
 * DTOs for the Content module (G09).
 *
 * @module content.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  MinLength,
} from 'class-validator';
import { ALL_ASSET_TYPES, GENERATABLE_ASSET_TYPES } from '../content.types';

export class ReferenceSourceDto {
  @ApiProperty()
  @IsString()
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateContentBriefDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  title: string;

  @ApiPropertyOptional({ enum: ALL_ASSET_TYPES, default: 'article' })
  @IsOptional()
  @IsIn(ALL_ASSET_TYPES)
  assetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetQuery?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  supportingQueries?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  audience?: string;

  @ApiPropertyOptional({ enum: ['informational', 'commercial', 'transactional', 'navigational'] })
  @IsOptional()
  @IsIn(['informational', 'commercial', 'transactional', 'navigational'])
  intent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  angle?: string;

  @ApiPropertyOptional({ type: [String], description: 'Required talking points the draft must cover.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mustInclude?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Claim ids (this project\'s Claim rows) the copy may assert.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  claimIds?: string[];

  @ApiPropertyOptional({ type: [ReferenceSourceDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReferenceSourceDto)
  references?: ReferenceSourceDto[];

  @ApiPropertyOptional({ description: 'What this brief answers, e.g. "gap".' })
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  wordTarget?: number;

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @IsString()
  language?: string;
}

/**
 * PATCH body. When the target brief is still `draft`, fields are mutated in
 * place. When it is `approved`/`archived` and a content field is being
 * changed, the service writes a NEW version row instead of mutating the
 * approved one — an approved version is never silently rewritten out from
 * under a generation job that already recorded its id.
 */
export class UpdateContentBriefDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  title?: string;

  @ApiPropertyOptional({ enum: ALL_ASSET_TYPES })
  @IsOptional()
  @IsIn(ALL_ASSET_TYPES)
  assetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetQuery?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  supportingQueries?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  audience?: string;

  @ApiPropertyOptional({ enum: ['informational', 'commercial', 'transactional', 'navigational'] })
  @IsOptional()
  @IsIn(['informational', 'commercial', 'transactional', 'navigational'])
  intent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  angle?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mustInclude?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  claimIds?: string[];

  @ApiPropertyOptional({ type: [ReferenceSourceDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReferenceSourceDto)
  references?: ReferenceSourceDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  wordTarget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ enum: ['draft', 'approved', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'approved', 'archived'])
  status?: string;
}

export class ListContentBriefsQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'approved', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'approved', 'archived'])
  status?: string;

  @ApiPropertyOptional({ enum: ALL_ASSET_TYPES })
  @IsOptional()
  @IsIn(ALL_ASSET_TYPES)
  assetType?: string;

  @ApiPropertyOptional({ description: 'Collapse to only the highest version per title.' })
  @IsOptional()
  @Type(() => Boolean)
  latestOnly?: boolean;
}

export class UpdateAssetContentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ description: 'Type-specific fields (meta description, slug, faq, jsonLd, ad variants, ...).' })
  @IsOptional()
  @IsObject()
  fields?: Record<string, unknown>;

  @ApiProperty({
    description:
      'The revision number this edit was based on (0 if only legacy GrowthAsset.content has ever existed). ' +
      'If the asset has moved past this version since it was read, the request is rejected with 409 rather than overwriting a concurrent edit.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion: number;
}

export class GenerationJobItemInputDto {
  @ApiProperty({ description: 'Caller-supplied identifier for this generation subject (a keyword, topic id, or angle label).' })
  @IsString()
  @MinLength(1)
  topicId: string;

  @ApiPropertyOptional({ description: 'Human-readable subject line, if different from topicId.' })
  @IsOptional()
  @IsString()
  subject?: string;
}

export class CreateGenerationJobDto {
  @ApiProperty({ description: 'The approved ContentBrief row id to generate from.' })
  @IsString()
  briefId: string;

  @ApiProperty({ description: 'The exact version of that brief the caller reviewed and approved. Must match the row\'s actual version or the request is rejected — "regenerate" never silently uses a different instruction set.' })
  @Type(() => Number)
  @IsInt()
  briefVersion: number;

  @ApiPropertyOptional({ enum: GENERATABLE_ASSET_TYPES, description: 'Defaults to the brief\'s own assetType. Only article/ad-copy can actually be generated; every other type stays brief-only.' })
  @IsOptional()
  @IsIn(GENERATABLE_ASSET_TYPES)
  assetType?: string;

  @ApiProperty({ type: [GenerationJobItemInputDto], description: 'The selected topics to generate one artifact each for. An empty array is valid and produces a zero-requested job, not an error.' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GenerationJobItemInputDto)
  items: GenerationJobItemInputDto[];

  @ApiPropertyOptional({ type: [String], description: 'Claim ids to ground the generated copy in, in addition to the brief\'s own claimIds.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceClaimIds?: string[];

  @ApiPropertyOptional({ description: 'Brand voice / context version label, recorded on the job for provenance.' })
  @IsOptional()
  @IsString()
  voiceContextVersion?: string;

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: 'Free-text constraints (length, tone, platform limits) appended to the generation instructions.' })
  @IsOptional()
  @IsString()
  constraints?: string;
}

export class RetryGenerationJobDto {
  @ApiPropertyOptional({ type: [String], description: 'Specific GenerationItem ids to retry. Defaults to every failed+retryable item on the job. Items that already succeeded are never re-run or re-charged.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];
}

export class ListGenerationJobsQueryDto {
  @ApiPropertyOptional({ enum: ['queued', 'running', 'partial', 'completed', 'failed'] })
  @IsOptional()
  @IsIn(['queued', 'running', 'partial', 'completed', 'failed'])
  status?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
