/**
 * DTOs for the Delivery module (PRD §6.11).
 *
 * @module delivery.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CTA_EVENT_TYPES, LEAD_SOURCES, LEAD_STATUSES, UPGRADE_TIERS } from '../delivery.types';

export class CreateLeadDto {
  @ApiProperty({ description: "Lead's email", example: 'ops@napkin.example' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ description: "Lead's name" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Funnel source', enum: LEAD_SOURCES, default: 'form' })
  @IsOptional()
  @IsIn(LEAD_SOURCES)
  source?: string;

  @ApiPropertyOptional({ description: 'Rung-0 run that generated this lead (source=scorecard)' })
  @IsOptional()
  @IsString()
  scorecardRunId?: string;
}

export class UpdateLeadDto {
  @ApiPropertyOptional({ description: 'Pipeline status', enum: LEAD_STATUSES })
  @IsOptional()
  @IsIn(LEAD_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: "Lead's name" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class LogCtaDto {
  @ApiProperty({ description: 'CTA type', enum: CTA_EVENT_TYPES, example: 'book-call' })
  @IsIn(CTA_EVENT_TYPES)
  type: string;

  @ApiPropertyOptional({ description: 'Free-form metadata (page, campaign, upgraded tier…)' })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}

export class SendReportDto {
  @ApiProperty({ description: 'Report URL to deliver (PDF is linked, not attached)', example: 'https://app.example.com/r/abc123' })
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  reportUrl: string;

  @ApiProperty({ description: 'Recipient (a lead email or any address)' })
  @IsEmail()
  to: string;

  @ApiPropertyOptional({ description: 'Optional subject override (operator-editable before send, FR-11.1)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  subject?: string;

  @ApiPropertyOptional({ description: 'Include the review/testimonial ask alongside the booking CTA (FR-11.3)' })
  @IsOptional()
  @Type(() => Boolean)
  includeTestimonialAsk?: boolean;
}