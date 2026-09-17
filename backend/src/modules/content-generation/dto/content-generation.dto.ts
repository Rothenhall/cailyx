import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { ALL_TRACKED_ASSET_TYPES } from '../../content-workspace/content-workspace.types';

class TopicInputDto {
  @ApiProperty() @IsString() targetKeyword!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() blogTopic?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() adAngle?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() searchVolume?: number;
}

export class ListGenerationJobsQueryDto {
  @ApiPropertyOptional({ enum: ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] })
  @IsOptional()
  @IsIn(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({ default: 20, description: 'Newest first.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateGenerationJobDto {
  /** Client-supplied dedupe key — a resubmit with the same key returns the existing job/output. */
  @ApiProperty() @IsString() idempotencyKey!: string;

  // Deliberately NOT narrowed to the implemented types here — a request for
  // any TRACKED type (e.g. email-campaign, seo-fix) must reach the SERVICE's
  // capability check and get an honest, specific 422 refusal (§13.9), not a
  // generic 400 "must be one of [article, ad-copy]" that looks like a
  // validation bug rather than a documented capability gap.
  //
  // `ALL_TRACKED_ASSET_TYPES` is the capability matrix's own row set, so the
  // two can never drift into disagreeing about which types exist. A type
  // outside it is not a capability gap — nothing tracks it — and stays a 400.
  @ApiProperty({ description: 'A tracked asset type (the capability matrix\'s row set). Only types with an implemented writer (§13.9) are actually accepted — every other tracked type is refused with a 422 capability reason.' })
  @IsIn(ALL_TRACKED_ASSET_TYPES)
  assetType!: (typeof ALL_TRACKED_ASSET_TYPES)[number];

  /** Existing GrowthAsset to add a revision to. Omitted = create a new content piece. */
  @ApiPropertyOptional() @IsOptional() @IsString() contentAssetId?: string;

  /** Approved ContentBrief driving this generation, if any. */
  @ApiPropertyOptional() @IsOptional() @IsString() briefId?: string;

  @ApiProperty({ type: TopicInputDto })
  @ValidateNested()
  @Type(() => TopicInputDto)
  topic!: TopicInputDto;

  /** Confirmed writing style version to pin. Omitted = the active confirmed style at enqueue time. */
  @ApiPropertyOptional() @IsOptional() @IsString() writingStyleProfileId?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() sourceEvidenceIds?: string[];

  @ApiPropertyOptional() @IsOptional() @IsObject() generationSettings?: Record<string, unknown>;
}
