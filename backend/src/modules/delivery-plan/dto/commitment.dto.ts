/**
 * DTOs for Commitment CRUD/lifecycle — `/api/projects/:projectId/commitments`.
 * See §6.1-6.3 of platform_improvement_plan.md.
 *
 * @module dto/commitment.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { COMMITMENT_WORKSTREAMS } from '../delivery-plan.types';

export class CreateCommitmentDto {
  @ApiProperty({ description: 'The cycle this commitment belongs to.' })
  @IsString()
  cycleId: string;

  @ApiProperty({ description: 'Plain-English outcome, e.g. "Publish ten useful articles for the new product".' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @ApiPropertyOptional({ description: 'Short reason this matters.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({ enum: COMMITMENT_WORKSTREAMS })
  @IsOptional()
  @IsIn(COMMITMENT_WORKSTREAMS as unknown as string[])
  workstream?: string;

  @ApiPropertyOptional({ description: 'Countable target, e.g. 10 (articles). Omit for a pure outcome goal.' })
  @IsOptional()
  @IsNumber()
  targetCount?: number;

  @ApiPropertyOptional({ description: 'Unit label for targetCount, e.g. "articles".' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  targetUnit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  targetDate?: string;

  @ApiPropertyOptional({ description: 'Outcome metric name, e.g. "Qualified visits".' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  outcomeMetricLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  outcomeMetricUnit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  outcomeMetricBaseline?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  outcomeMetricTarget?: number;

  @ApiPropertyOptional({ description: 'Staff userId accountable for this commitment.' })
  @IsOptional()
  @IsString()
  accountableLead?: string;

  @ApiPropertyOptional({ description: 'Show the real lead name to the client instead of "Your Cailyx team".' })
  @IsOptional()
  @IsBoolean()
  clientVisibleLead?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'WorkItem ids belonging to this commitment; validated against the project.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  linkedWorkItemIds?: string[];

  @ApiPropertyOptional({ description: 'Loose reference to relevant content/results (id or URL).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  contentRef?: string;
}

export class UpdateCommitmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({ enum: COMMITMENT_WORKSTREAMS })
  @IsOptional()
  @IsIn(COMMITMENT_WORKSTREAMS as unknown as string[])
  workstream?: string;

  @ApiPropertyOptional({ description: 'Staff userId accountable for this commitment.' })
  @IsOptional()
  @IsString()
  accountableLead?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  clientVisibleLead?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  linkedWorkItemIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  contentRef?: string;
}

/** Generic forward transition — never accepts "agreed" (use `/agree`),
 * matching cycle's dedicated-commit pattern. */
export class SetCommitmentStatusDto {
  @ApiProperty()
  @IsString()
  status: string;
}

/** "Agreed" requires an explicit confirmation, never a bare status PATCH. */
export class AgreeCommitmentDto {
  @ApiProperty({ description: 'Must be true — an explicit, deliberate act.' })
  @IsBoolean()
  confirm: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** A scope change: previous/new target+date, reason, whether the client must
 * reconfirm. §6.3. */
export class CommitmentScopeChangeDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  newTarget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  newDate?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresReconfirmation?: boolean;
}

/** Records an observed value for an outcome-style commitment. Never implied
 * by linked WorkItems closing. */
export class RecordOutcomeMetricDto {
  @ApiProperty()
  @IsNumber()
  value: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  observedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Marks a commitment completed. For a countable commitment this is refused
 * unless verified >= targetCount, or `force` + `forceReason` is supplied.
 * For an outcome-style commitment this REQUIRES a metric observation — via
 * `outcomeMetricCurrent`, or one already on file from `RecordOutcomeMetricDto`
 * dated at or after this call. */
export class CompleteCommitmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  outcomeMetricCurrent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  outcomeMetricObservedAt?: string;

  @ApiPropertyOptional({ description: 'Override an unmet countable target — requires forceReason.' })
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  forceReason?: string;
}

export class CancelCommitmentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}
