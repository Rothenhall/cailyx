/**
 * DTOs for the durable job ledger — `/api/projects/:projectId/jobs`.
 *
 * @module dto/jobs.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JOB_RUN_STATUSES, JOB_TRIGGERS, TASK_KINDS } from '../jobs.types';

/** Query params for listing a project's runs. */
export class ListRunsQueryDto {
  @ApiPropertyOptional({ enum: TASK_KINDS, description: 'Filter by task kind.' })
  @IsOptional()
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind?: string;

  @ApiPropertyOptional({ enum: JOB_RUN_STATUSES, description: 'Filter by run status.' })
  @IsOptional()
  @IsIn(JOB_RUN_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ description: 'Max rows (1-200, default 50).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Body for creating a run. The `idempotencyKey` is the whole point of this
 * endpoint: a caller that repeats the call — a retried HTTP request, a
 * scheduler that fired twice — gets the **same** run back rather than a
 * second one.
 */
export class CreateRunDto {
  @ApiProperty({ enum: TASK_KINDS, description: 'What kind of work this run is.' })
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind: string;

  @ApiPropertyOptional({
    description:
      'De-duplication key. Supplying the same key again returns the existing run instead of starting a second one. Omit it only when a genuinely new run is intended every time.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;

  @ApiPropertyOptional({ enum: JOB_TRIGGERS, default: 'manual', description: 'How the run came to exist.' })
  @IsOptional()
  @IsIn(JOB_TRIGGERS as unknown as string[])
  trigger?: string;

  @ApiPropertyOptional({ description: 'Human-readable current stage, if the caller already knows it.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  stage?: string;

  @ApiPropertyOptional({ description: 'Run parameters as submitted. Stored verbatim; retries reuse them.' })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Step names to create up front, in order — the stage skeleton the worker fills in.' })
  @IsOptional()
  @IsString({ each: true })
  steps?: string[];

  @ApiPropertyOptional({ description: 'Bounded retry budget (1-10, default 3).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether cancelling can still undo what the run produces. Set false for work with an external side effect (a published page, a sent email) so the cancel disclosure can say so.',
  })
  @IsOptional()
  @IsBoolean()
  reversible?: boolean;

  @ApiPropertyOptional({ description: 'Hard cost ceiling for this run, in USD. Recorded, and passed to the executor.' })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  maxCostUsd?: number;
}

/** Body for cancelling a run. */
export class CancelRunDto {
  @ApiPropertyOptional({ description: 'Why it was cancelled — stored on the run and shown next to the disclosure.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** Body for recording a step outcome directly (used by modules that drive a run themselves). */
export class RecordStepDto {
  @ApiProperty({ description: 'Step name — must match a step created with the run, or a new one is appended.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'] })
  @IsIn(['pending', 'running', 'succeeded', 'failed', 'skipped'])
  status: string;

  @ApiPropertyOptional({ description: 'Items attempted — the denominator of the coverage disclosure.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  attempted?: number;

  @ApiPropertyOptional({ description: 'Items that actually returned a result — the numerator.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  succeeded?: number;

  @ApiPropertyOptional({ description: 'What went wrong, when something did. Never a substitute for the coverage counts.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;

  @ApiPropertyOptional({ description: 'Cost attributed to this step, in USD.' })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  costUsd?: number;
}
