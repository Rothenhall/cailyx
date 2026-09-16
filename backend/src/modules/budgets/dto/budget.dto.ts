/**
 * DTOs for budget policies and cost estimates — G12.
 *
 * `/api/projects/:projectId/budget` and `/api/projects/:projectId/cost-estimates`.
 *
 * @module dto/budget.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BUDGET_ENFORCEMENTS, BUDGET_PERIODS, TASK_KINDS } from '../budgets.types';

/**
 * Body for `PUT /api/projects/:projectId/budget`.
 *
 * At least one of `limitUsd` / `limitCredits` / `perRunCapUsd` must be set —
 * a policy that caps nothing is not a policy, and silently storing one would
 * report "bounded" for work that is not.
 */
export class PutBudgetPolicyDto {
  @ApiPropertyOptional({
    enum: TASK_KINDS as unknown as string[],
    description:
      'Write an operation-level ceiling for one task kind instead of the project-wide one. ' +
      'Omit to write the project-wide policy that covers every task kind.',
  })
  @IsOptional()
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind?: string;

  @ApiPropertyOptional({
    description:
      'Ceiling in US dollars for the period. Null clears the dollar ceiling without touching the credit one.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  limitUsd?: number | null;

  @ApiPropertyOptional({
    description:
      'Ceiling in provider credits for the period. Credits are a separate quantity from dollars and are never converted into the dollar ceiling implicitly.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  limitCredits?: number | null;

  @ApiPropertyOptional({ enum: BUDGET_PERIODS as unknown as string[], default: 'month' })
  @IsOptional()
  @IsIn(BUDGET_PERIODS as unknown as string[])
  period?: string;

  @ApiPropertyOptional({
    enum: BUDGET_ENFORCEMENTS as unknown as string[],
    default: 'hard',
    description:
      'hard refuses a reservation that would pass the ceiling. soft creates it held and unapproved: it still blocks a second overage, and it cannot be settled until an approving role confirms.',
  })
  @IsOptional()
  @IsIn(BUDGET_ENFORCEMENTS as unknown as string[])
  enforcement?: string;

  @ApiPropertyOptional({
    description:
      'Ceiling for one single run, in USD. Applies regardless of how much of the period ceiling is left.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  perRunCapUsd?: number | null;
}

/**
 * Body for `POST /api/projects/:projectId/cost-estimates`.
 *
 * This is a **pre-flight estimate**, not a charge and not a reservation:
 * design_plan.md G12 — "estimates differ from actual and carry units". For
 * `taskKind: 'aeo-audit'` the answer is a Cloro **credit** estimate for the
 * answer-engine sampling, because that is the only estimator that exists in
 * this codebase; it is reported with `unit: 'credits'` and its tariff basis,
 * alongside — not merged into — any dollar figure.
 */
export class CreateCostEstimateDto {
  @ApiProperty({ enum: TASK_KINDS as unknown as string[], description: 'What kind of work is being estimated.' })
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind: string;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'For aeo-audit: the engine ids the run would use (chatgpt-browser, cloro-chatgpt, …). ' +
      'Omitted means the configured default set is used, and the response says which it assumed.',
  })
  @IsOptional()
  @IsString({ each: true })
  surfaces?: string[];

  @ApiPropertyOptional({ description: 'For aeo-audit: prompts in the matrix (this is the matrix tier size).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  prompts?: number;

  @ApiPropertyOptional({ description: 'For aeo-audit: repeats per prompt. The AEO module enforces a floor of 5.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  runCount?: number;

  @ApiPropertyOptional({ description: 'For aeo-audit: markets the run covers (>= 1).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  markets?: number;

  @ApiPropertyOptional({
    description:
      'The requested configuration, echoed back verbatim in the response so the estimate can be tied to the exact parameters it was priced for.',
  })
  @IsOptional()
  @IsObject()
  requestedConfiguration?: Record<string, unknown>;

  @ApiPropertyOptional({
    default: false,
    description:
      'Ask the provider for its current balance. Off by default so a dry estimate makes no network call. ' +
      'When on and the balance cannot be read, the response reports affordability "unknown" with the reason — never "affordable".',
  })
  @IsOptional()
  @IsBoolean()
  checkProviderBalance?: boolean;
}

/** Query for `GET /api/projects/:projectId/budget`. */
export class GetBudgetQueryDto {
  @ApiPropertyOptional({
    enum: TASK_KINDS as unknown as string[],
    description: 'Evaluate as if this task kind were about to run, so operation-level ceilings are included.',
  })
  @IsOptional()
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind?: string;
}

/** Query for `GET /api/projects/:projectId/spend`. */
export class ListSpendQueryDto {
  @ApiPropertyOptional({ description: 'Inclusive lower bound on occurredAt (ISO 8601).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @ApiPropertyOptional({ description: 'Exclusive upper bound on occurredAt (ISO 8601).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @ApiPropertyOptional({ enum: TASK_KINDS as unknown as string[] })
  @IsOptional()
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind?: string;

  @ApiPropertyOptional({ description: 'Provider id (e.g. cloro, dataforseo, anthropic).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  provider?: string;

  @ApiPropertyOptional({ enum: ['usd', 'credits'], description: 'Return only events recorded in this unit.' })
  @IsOptional()
  @IsIn(['usd', 'credits'])
  unit?: string;

  @ApiPropertyOptional({ description: 'Max events returned (1-500, default 100).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
