/**
 * DTOs for the Growth Execution module (stage 11).
 *
 * @module growth-execution.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ASSET_TYPES, type AssetType } from '../growth-execution.types';

export class CreateAssetsDto {
  @ApiPropertyOptional({
    description: 'Which asset types to generate. Defaults to all nine the flowchart draws.',
    enum: ASSET_TYPES,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsIn(ASSET_TYPES, { each: true })
  assetTypes?: AssetType[];

  @ApiPropertyOptional({
    description: 'Max source gaps per recommendation category to generate from. Defaults to 2, capped at 5.',
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  perCategoryLimit?: number;

  @ApiPropertyOptional({
    description:
      'Refine each brief with one constrained LLM call instead of the deterministic template. Requires OPENROUTER_API_KEY or ANTHROPIC_API_KEY — 503 naming it when missing, before anything is generated.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}

/** "Create Recommended Assets" for the two content-bearing types — real generated copy, not a brief. */
export class GenerateContentDto {
  @ApiPropertyOptional({
    description: 'Which of the two content-bearing types to generate. Defaults to both.',
    enum: ['article', 'ad-copy'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsIn(['article', 'ad-copy'], { each: true })
  assetTypes?: Array<'article' | 'ad-copy'>;

  @ApiPropertyOptional({ description: 'How many priority-keyword topics to generate content for. Defaults to 3, capped at 10 (cost/time bound — each article is its own LLM call).' })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

export class ListAssetsQueryDto {
  @ApiPropertyOptional({ enum: ASSET_TYPES })
  @IsOptional()
  @IsIn(ASSET_TYPES)
  assetType?: AssetType;

  @ApiPropertyOptional({ enum: ['recommended', 'in-progress', 'published'] })
  @IsOptional()
  @IsIn(['recommended', 'in-progress', 'published'])
  status?: string;
}

export class UpdateAssetStatusDto {
  @IsIn(['recommended', 'in-progress', 'published'])
  status: 'recommended' | 'in-progress' | 'published';

  @ApiPropertyOptional({ description: 'Stamped onto the row when provided; required in practice once status is "published".' })
  @IsOptional()
  @IsString()
  assetUrl?: string;
}
