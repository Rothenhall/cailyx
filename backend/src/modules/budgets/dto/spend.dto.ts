/**
 * DTOs for spend events and spend reservations — G12.
 *
 * `/api/projects/:projectId/spend` and
 * `/api/projects/:projectId/budget/reservations`.
 *
 * @module dto/spend.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RESERVATION_STATUSES, SPEND_UNITS, TASK_KINDS } from '../budgets.types';

/**
 * Body for `POST /api/projects/:projectId/budget/reservations` — the
 * reserve-before-spend action.
 *
 * `reservedUsd` / `reservedCredits` are what gets set aside and what the
 * ceiling is checked against. The estimate range is recorded alongside it so
 * the audit can compare what was predicted with what was settled, which is
 * the whole reason both exist (design_plan.md G12: "estimates differ from
 * actual").
 */
export class CreateReservationDto {
  @ApiProperty({ enum: TASK_KINDS as unknown as string[], description: 'The work this reservation is for.' })
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind: string;

  @ApiPropertyOptional({ description: 'The G07 run this reservation belongs to, when there is one.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobRunId?: string;

  @ApiPropertyOptional({ description: 'Low end of the estimate, in USD.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimateLowUsd?: number;

  @ApiPropertyOptional({
    description: 'High end of the estimate, in USD. This is what the per-run cap is checked against.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimateHighUsd?: number;

  @ApiPropertyOptional({ description: 'USD to set aside. Defaults to the high estimate.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reservedUsd?: number;

  @ApiPropertyOptional({
    description:
      'Credits to set aside. Credits are never converted into reservedUsd — a credit ceiling is checked against credit reservations only.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reservedCredits?: number;

  @ApiPropertyOptional({
    description:
      'Provider the spend will go to (cloro, dataforseo, anthropic, openrouter, apify, psi, …). Recorded on the settlement event.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  provider?: string;

  @ApiPropertyOptional({
    default: 60,
    description:
      'Minutes the hold lives before it lapses. An expired hold stops counting against the ceiling — a crashed run must not block the next one forever.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  ttlMinutes?: number;
}

/** Query for `GET /api/projects/:projectId/budget/reservations`. */
export class ListReservationsQueryDto {
  @ApiPropertyOptional({ enum: RESERVATION_STATUSES as unknown as string[], description: 'Filter by status.' })
  @IsOptional()
  @IsIn(RESERVATION_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: TASK_KINDS as unknown as string[] })
  @IsOptional()
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind?: string;

  @ApiPropertyOptional({ description: 'Only reservations held for this G07 run.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobRunId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Only held reservations that exceeded a soft ceiling and have no approver yet — the approval queue.',
  })
  @IsOptional()
  @Type(() => Boolean)
  awaitingApprovalOnly?: boolean;

  @ApiPropertyOptional({ description: 'Max rows (1-200, default 50).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Body for `POST .../reservations/:id/settle` — record what was actually
 * charged.
 *
 * Settling is one-way and happens exactly once: a second call against the same
 * reservation is a 409, not a second charge. That is what makes a retried run
 * or a cache hit safe.
 */
export class SettleReservationDto {
  @ApiPropertyOptional({
    description:
      'The actual USD charge. Defaults to the reserved USD when the provider does not report one — but a defaulted figure is labelled as such in the response.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  settledUsd?: number;

  @ApiPropertyOptional({ description: 'The actual credit charge, from the provider response (e.g. Cloro creditsCharged).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  settledCredits?: number;

  @ApiPropertyOptional({ description: 'Provider the charge came from. Falls back to the reservation request, then "unknown".' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  provider?: string;

  @ApiPropertyOptional({ description: 'How many units of work were bought (requests, prompts, pages, tokens).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ description: 'What `quantity` counts — "requests", "prompts", "pages".' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  quantityUnit?: string;

  @ApiPropertyOptional({ description: 'Short audit note recorded on the spend event.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Settle even though the charge exceeded the reserved amount. Without it, an over-reservation settlement is refused (409) so an unbounded overrun is a decision, not an accident.',
  })
  @IsOptional()
  @Type(() => Boolean)
  acknowledgeOverReservation?: boolean;
}

/**
 * Body for `POST .../reservations/:id/release`.
 *
 * Deliberately empty. `SpendReservation` has no column for a release reason,
 * and accepting one that would be silently dropped is worse than not offering
 * it — see the module README's "missing columns" note.
 */
/**
 * Body for `POST .../reservations/:id/release`.
 *
 * The reason is optional but recorded: releasing a hold is the one budget
 * action that both frees money and leaves no charge behind, so "why did this
 * hold disappear?" is a question the ledger should be able to answer. The
 * column did not exist when this DTO was first written, which is why it was an
 * empty class and the route accepted no body at all.
 */
export class ReleaseReservationDto {
  @ApiPropertyOptional({
    description: 'Why this hold is being given back, e.g. "run cancelled before the provider was called".',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * Body for `POST /api/projects/:projectId/spend` — record a charge that was
 * never reserved (a free-tier call, or work predating the ledger).
 *
 * A reservation must always be recorded *before* it is spent, so this route
 * exists for the two honest exceptions and refuses an event that carries
 * neither a `reservationId` nor a `jobRunId`: without one of them the event
 * cannot be de-duplicated against a retry, and an un-deduplicable ledger is
 * worse than no ledger.
 */
export class RecordSpendEventDto {
  @ApiProperty({ description: 'Provider id (cloro, dataforseo, anthropic, openrouter, apify, psi, …).' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  provider: string;

  @ApiProperty({ enum: SPEND_UNITS as unknown as string[], description: 'usd or credits — never both, never summed.' })
  @IsIn(SPEND_UNITS as unknown as string[])
  unit: string;

  @ApiProperty({ description: 'The amount, in `unit`.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiPropertyOptional({ enum: TASK_KINDS as unknown as string[] })
  @IsOptional()
  @IsIn(TASK_KINDS as unknown as string[])
  taskKind?: string;

  @ApiPropertyOptional({ description: 'The reservation this settles against. Required when there is no jobRunId.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reservationId?: string;

  @ApiPropertyOptional({ description: 'The G07 run that incurred it. Required when there is no reservationId.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobRunId?: string;

  @ApiPropertyOptional({ description: 'How many units of work were bought.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ description: 'What `quantity` counts — "requests", "tokens", "pages".' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  quantityUnit?: string;

  @ApiPropertyOptional({ description: 'Short audit note.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'When the charge occurred. Defaults to now.' })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}
