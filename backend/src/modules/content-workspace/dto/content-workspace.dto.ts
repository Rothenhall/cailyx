/**
 * DTOs for the Content Workspace module (P08).
 *
 * @module content-workspace.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  CONTENT_WORKSPACE_ASSET_TYPES,
  CONTENT_WORKSPACE_VIEWS,
  EDITORIAL_STATES,
} from '../content-workspace.types';

export class ListContentWorkspaceQueryDto {
  @ApiPropertyOptional({ enum: CONTENT_WORKSPACE_VIEWS, description: '§13.1 saved view. Server-side, so it matches `total`.' })
  @IsOptional()
  @IsIn(CONTENT_WORKSPACE_VIEWS)
  view?: string;

  @ApiPropertyOptional({ description: 'Title/topic search, case-insensitive substring.' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: CONTENT_WORKSPACE_ASSET_TYPES })
  @IsOptional()
  @IsIn(CONTENT_WORKSPACE_ASSET_TYPES)
  assetType?: string;

  @ApiPropertyOptional({ enum: EDITORIAL_STATES })
  @IsOptional()
  @IsIn(EDITORIAL_STATES)
  editorialState?: string;

  @ApiPropertyOptional({ description: 'search-gap | manual | opportunity-<origin>' })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  market?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ enum: ['shared', 'not-shared'] })
  @IsOptional()
  @IsIn(['shared', 'not-shared'])
  clientVisibility?: 'shared' | 'not-shared';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class SetAssigneeDto {
  @ApiPropertyOptional({ description: 'User id to assign, or omit/null to unassign.' })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;
}

export class MergeBriefFamiliesDto {
  @IsString()
  fromFamilyId: string;

  @IsString()
  intoFamilyId: string;
}
