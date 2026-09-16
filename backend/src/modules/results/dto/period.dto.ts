/**
 * DTOs for `ReportPeriod` — the stored, reproducible reporting window
 * (`/api/projects/:projectId/report-periods`).
 *
 * @module dto/period.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePeriodDto {
  @ApiProperty({ description: 'Display label, e.g. "March 2026" or "Baseline — 1-31 March".' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label: string;

  @ApiProperty({ description: 'Inclusive window start — `YYYY-MM-DD`, resolved at 00:00:00.000 in `timezone`.' })
  @IsISO8601({ strict: false })
  @MaxLength(40)
  startsOn: string;

  @ApiProperty({ description: 'Inclusive window end — `YYYY-MM-DD`, resolved at 23:59:59.999 in `timezone`.' })
  @IsISO8601({ strict: false })
  @MaxLength(40)
  endsOn: string;

  @ApiPropertyOptional({ default: 'UTC', description: 'IANA timezone the bounds are resolved in. Stored with the period so the window never re-resolves against a later viewer\'s clock.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ description: 'The MeasurementCohort this period was measured under.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cohortId?: string;

  @ApiPropertyOptional({ description: 'The period this one is compared against. Stored, so a comparison is reproducible rather than re-guessed from "the previous month".' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baselinePeriodId?: string;
}

/**
 * Editing a stored period is restricted on purpose in the service: a period
 * that has been pinned by an evidence manifest is immutable, because changing
 * its bounds would silently re-point a frozen snapshot at a different window.
 */
export class UpdatePeriodDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  @MaxLength(40)
  startsOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  @MaxLength(40)
  endsOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cohortId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baselinePeriodId?: string;
}
