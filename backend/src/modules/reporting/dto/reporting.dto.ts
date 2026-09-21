/**
 * DTOs for the Reporting module.
 *
 * @module reporting.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';

export class GenerateReportDto {
  @ApiProperty()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  targetUrl: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  /**
   * G13 — the reporting window this report covers.
   *
   * Supply a stored `ReportPeriod` id and the report reproduces that exact
   * window forever. Omit it and the window is derived from today's date, which
   * is fine for a fresh diagnostic and wrong for anything historical, so the
   * report records which of the two happened.
   */
  @ApiPropertyOptional({ description: 'Stored ReportPeriod id. Pins the exact window; without it a moving window is used.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  periodId?: string;

  /**
   * G13 — the methodology cohort. Two reports are only comparable when their
   * cohort (query set + engines + markets + transport) matches; recording it
   * is what lets a later reader tell a real movement from a methodology change.
   */
  @ApiPropertyOptional({ description: 'MeasurementCohort id this report belongs to.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cohortId?: string;

  // Note: there is deliberately no `baselinePeriodId` here. A ReportPeriod
  // already records the period it compares against, and letting a report
  // override that would give "what is this compared to?" two answers.
}

export class SetVisibilityDto {
  @ApiProperty({ enum: ['private', 'public'] })
  @IsIn(['private', 'public'])
  visibility: 'private' | 'public';
}

// ─── G05 — Editorial lifecycle ─────────────────────────────────

export class ReviewReportDto {
  @ApiPropertyOptional({ description: 'Note explaining why the snapshot is being (re-)locked for review.' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class ApproveReportDto {
  @ApiProperty({ enum: ['approved', 'changes-requested'] })
  @IsIn(['approved', 'changes-requested'])
  decision: 'approved' | 'changes-requested';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class PublishReportDto {
  @ApiPropertyOptional({ description: 'Optional release note recorded on the revision.' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class WithdrawReportDto {
  @ApiProperty({ description: 'Why the released report is being pulled back from the client.' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class CreateShareLinkDto {
  @ApiPropertyOptional({ description: 'Hours from now until the link expires. Omit for a non-expiring link (still revocable).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expiresInHours?: number;

  /**
   * C6 §31 — optional password. When set, the public render prompts for it
   * before serving the report. Stored only as a bcrypt hash. 4–72 chars (72 is
   * bcrypt's input cap; the same cap the auth module applies to user passwords).
   */
  @ApiPropertyOptional({ description: 'Optional password required to open the link. Stored hashed. 4–72 characters. Omit for no password.' })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(72)
  password?: string;
}

/**
 * C6 §31 — body of the public unlock POST. The password a recipient types on
 * the password-prompt page for a password-protected share link.
 */
export class UnlockShareLinkDto {
  @ApiProperty({ description: 'The password set on this share link.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password: string;

  @ApiPropertyOptional({ enum: ['executive', 'detailed'], description: 'Which view to open after unlocking.' })
  @IsOptional()
  @IsIn(['executive', 'detailed'])
  view?: string;
}

export class DeliverReportDto {
  @ApiProperty({ description: 'Recipient email address. Required for every channel: the ledger records who the report was sent to, and "manual" means the operator sent it outside Cailyx.' })
  @IsString()
  @IsNotEmpty()
  recipient: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ enum: ['email', 'link-share', 'manual'], default: 'email', description: 'email sends via the configured provider; link-share and manual record an attempt the operator made outside Cailyx.' })
  @IsOptional()
  @IsIn(['email', 'link-share', 'manual'])
  channel?: 'email' | 'link-share' | 'manual';

  @ApiPropertyOptional({ description: 'Absolute URL the recipient will open. Defaults to the report\'s public share link when one exists; required otherwise for the email channel.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reportUrl?: string;
}

export class ListDeliveryAttemptsQueryDto {
  @ApiPropertyOptional({ description: 'Max rows, newest first (default 50, max 200).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ListShareLinksQueryDto {
  @ApiPropertyOptional({ description: 'Include revoked and expired links (default true — revocation history is the point of the record).' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeRevoked?: boolean;
}

/**
 * D11 migration — classify reports that predate G05.
 *
 * `dryRun` reports what *would* be classified and writes nothing, so the
 * policy can be inspected on the real rows before it is applied. Idempotent:
 * a report that already has a released revision or any revision row is
 * skipped, so re-running is safe.
 */
export class ClassifyLegacyReportsDto {
  @ApiPropertyOptional({ default: false, description: 'Report the classification without writing it.' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}