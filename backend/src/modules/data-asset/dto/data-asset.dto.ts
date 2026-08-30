/**
 * DTOs for the Data Asset module (SOP-8, P3).
 *
 * @module data-asset.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateDataAssetDto {
  @ApiProperty({ description: 'Asset working title', example: 'The 2026 AI Visibility Benchmarks Report' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ description: 'How the brand attaches', enum: ['brand-named', 'subject-matter'], default: 'brand-named' })
  @IsOptional()
  @IsIn(['brand-named', 'subject-matter'])
  brandAlignment?: string;

  @ApiPropertyOptional({ description: 'Methodology note (sourceable numbers require it — claims discipline)' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  methodologyNote?: string;

  @ApiPropertyOptional({ description: 'Survey/sample size if applicable' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  surveySize?: number;

  @ApiPropertyOptional({ description: 'Published URL' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  assetUrl?: string;
}

export class UpdateDataAssetDto {
  @ApiPropertyOptional({ description: 'Asset title' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'How the brand attaches', enum: ['brand-named', 'subject-matter'] })
  @IsOptional()
  @IsIn(['brand-named', 'subject-matter'])
  brandAlignment?: string;

  @ApiPropertyOptional({ description: 'Methodology note' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  methodologyNote?: string;

  @ApiPropertyOptional({ description: 'Survey/sample size' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  surveySize?: number;

  @ApiPropertyOptional({ description: 'Published URL' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  assetUrl?: string;

  @ApiPropertyOptional({ description: 'Lifecycle (published stamps publishedAt)', enum: ['planned', 'fielding', 'published'] })
  @IsOptional()
  @IsIn(['planned', 'fielding', 'published'])
  status?: string;
}