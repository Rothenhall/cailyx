/**
 * DTOs for Phase CRUD/assignment — `/api/projects/:projectId/phases`.
 *
 * C3, Option B (docs/analysis/engagement-timeline.md §2): Phase is a thin
 * grouping label above Cycle/Commitment, purely for client-facing display.
 * It carries no lifecycle or approval mechanics of its own.
 *
 * @module dto/phase.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PHASE_STATUSES } from '../delivery-plan.types';

export class CreatePhaseDto {
  @ApiProperty({ description: 'Client-facing phase name, e.g. "Diagnose".' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ description: 'Sequencing among this project\'s phases, ascending. Defaults to end of list.' })
  @IsOptional()
  @IsInt()
  order?: number;

  @ApiPropertyOptional({ enum: PHASE_STATUSES, description: 'Admin-set display hint. Defaults to "upcoming".' })
  @IsOptional()
  @IsIn(PHASE_STATUSES as unknown as string[])
  status?: string;
}

export class UpdatePhaseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  order?: number;

  @ApiPropertyOptional({ enum: PHASE_STATUSES })
  @IsOptional()
  @IsIn(PHASE_STATUSES as unknown as string[])
  status?: string;
}

/**
 * Assigns (or clears, with `phaseId: null`) an existing Cycle or Commitment
 * to a Phase. Exactly one of `cycleId`/`commitmentId` is expected per call —
 * the service rejects both-or-neither so a single request always has an
 * unambiguous target.
 */
export class AssignToPhaseDto {
  @ApiPropertyOptional({ description: 'Cycle to assign to this phase.' })
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Commitment to assign to this phase.' })
  @IsOptional()
  @IsString()
  commitmentId?: string;
}
