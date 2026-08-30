/**
 * DTOs for the Crawler Monitor module.
 *
 * @module crawler-monitor.dto
 */

import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class IngestHitDto {
  @IsString()
  @MinLength(4)
  timestamp: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  url: string;

  @IsString()
  @MinLength(4)
  @MaxLength(500)
  userAgent: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;
}

export class IngestDto {
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => IngestHitDto)
  hits?: IngestHitDto[];

  /** Raw combined-log-format text; lines with non-bot UAs are skipped (counted). */
  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  logText?: string;
}

export class ListHitsQueryDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsIn(['training', 'search', 'citation-engine', 'unknown'])
  @IsOptional()
  botType?: string;
}