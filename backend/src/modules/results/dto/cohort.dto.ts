/**
 * DTOs for `MeasurementCohort` — the named, methodology-stable basis for
 * comparison (`/api/projects/:projectId/measurement-cohorts`).
 *
 * @module dto/cohort.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCohortDto {
  @ApiProperty({ description: 'Human name, e.g. "Standard engine set, March baseline".' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ description: 'The query set this cohort measures with.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  querySetId?: string;

  @ApiPropertyOptional({ description: 'The query set version in force. Part of the comparison key — a version bump is a methodology break.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  querySetVersion?: number;

  @ApiPropertyOptional({ type: [String], description: 'Engine/surface ids included, e.g. ["chatgpt-browser","perplexity-browser"].' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  engines?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Markets included, e.g. ["US","GB"].' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  markets?: string[];

  @ApiPropertyOptional({ description: 'How the engine was reached — e.g. "browser-session" or "api". A transport change is a methodology break.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  transport?: string;

  @ApiPropertyOptional({ description: 'The run to treat as this cohort\'s baseline. Must belong to this project.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baselineRunId?: string;
}

/**
 * Every field is optional; a PATCH changes the methodology key and the service
 * recomputes `methodologyHash`, appending a break rather than letting the two
 * periods quietly compare against each other.
 */
export class UpdateCohortDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  querySetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  querySetVersion?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  engines?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  markets?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  transport?: string;

  /**
   * Required when the edit changes the methodology key. Without it the update
   * is refused (409): a silent methodology change is exactly the failure this
   * model exists to prevent, and the reason ends up in `breaks`.
   */
  @ApiPropertyOptional({ description: 'Why the methodology changed. Required when the query set, engines, markets or transport move.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  breakReason?: string;
}

/** Body for explicitly recording a break without changing any field (e.g. a provider silently changed its model). */
export class RecordBreakDto {
  @ApiProperty({ description: 'What changed, in the operator\'s words. Stored on the cohort and surfaced on every comparison against it.' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
