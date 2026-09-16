/**
 * DTOs for Cycle CRUD/commit — `/api/projects/:projectId/cycles`.
 *
 * @module dto/cycle.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CYCLE_STATUSES } from '../delivery-plan.types';

export class CreateCycleDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ description: 'Engagement this cycle draws its scope/capacity from.' })
  @IsOptional()
  @IsString()
  engagementId?: string;

  @ApiProperty()
  @IsISO8601()
  startsOn: string;

  @ApiProperty()
  @IsISO8601()
  endsOn: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  goal?: string;
}

export class UpdateCycleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  startsOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  goal?: string;
}

/** Generic forward transition (e.g. committed -> active -> review -> closed).
 * Never accepts "committed" as a target — that only happens through the
 * dedicated `/commit` action, which also freezes the denominator. */
export class SetCycleStatusDto {
  @ApiProperty({ enum: CYCLE_STATUSES })
  @IsIn(CYCLE_STATUSES as unknown as string[])
  status: string;
}

export class CommitCycleDto {
  @ApiPropertyOptional({ description: 'Optional note on the commitment itself, not a scope-change reason.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Adding/removing a work item's cycle membership after commit — always
 * requires a reason, appended to Cycle.scopeChanges. */
export class ScopeChangeDto {
  @ApiProperty({ description: 'Why the committed scope is changing.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}
