/**
 * DTOs for cadence rules — `/api/projects/:projectId/cadences/:taskKind`.
 *
 * @module dto/cadence.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CADENCE_FREQUENCIES } from '../jobs.types';

/**
 * Body for creating/replacing a cadence rule. PUT replaces the rule, so an
 * omitted field falls back to the stored value and then to the documented
 * default — never to a silently different schedule.
 */
export class PutCadenceDto {
  @ApiPropertyOptional({ enum: CADENCE_FREQUENCIES, default: 'off', description: '`off` means manual-only: the rule never ticks.' })
  @IsOptional()
  @IsIn(CADENCE_FREQUENCIES as unknown as string[])
  frequency?: string;

  @ApiPropertyOptional({ description: '0-6, Sunday = 0. Required for weekly/biweekly.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional({ description: '1-31. Required for monthly/quarterly. A month shorter than this fires on its last day.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;

  @ApiPropertyOptional({ description: 'Local hour in `timezone` (0-23, default 3).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  hour?: number;

  @ApiPropertyOptional({ description: 'IANA timezone the schedule is expressed in, e.g. Europe/London. Defaults to the project\'s timezone.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ default: false, description: 'Disabling a rule stops future ticks; it never cancels a run already in flight.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Pause the rule without losing its schedule (typically because the client or engagement is paused). A paused rule does not tick.' })
  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @ApiPropertyOptional({ description: 'Run parameters applied on every tick.' })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Capability keys (CapabilityStatus.key) that must be configured, non-mock and verified before this rule ticks. An unmet prerequisite SKIPS the tick with the reason recorded — it never fails loudly every night.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  prerequisites?: string[];

  @ApiPropertyOptional({ description: 'Hard cost ceiling per tick, in USD. Recorded on each run it starts.' })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  maxCostUsd?: number;
}

/** Body for an explicit "run this cadence now". */
export class RunCadenceNowDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Proceed even though the rule\'s prerequisites are not ready. This is an explicit acceptance of the risk and is recorded on the rule; without it the request is refused so the unmet prerequisite cannot be missed.',
  })
  @IsOptional()
  @IsBoolean()
  overridePrerequisites?: boolean;

  @ApiPropertyOptional({ description: 'Why this is being run out of band. Recorded on the run.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
