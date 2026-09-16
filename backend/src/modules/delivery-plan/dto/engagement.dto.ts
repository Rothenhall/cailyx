/**
 * DTOs for Engagement CRUD — `/api/clients/:clientId/engagements`.
 *
 * @module dto/engagement.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { ENGAGEMENT_STATUSES, SERVICE_TIERS } from '../delivery-plan.types';

export class CreateEngagementDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ enum: SERVICE_TIERS, default: 'retainer' })
  @IsOptional()
  @IsIn(SERVICE_TIERS as unknown as string[])
  serviceTier?: string;

  @ApiPropertyOptional({ description: 'IANA timezone, e.g. "America/New_York". Every due date on this engagement (and projects created under it) resolves against this zone, never the caller\'s clock.' })
  @IsOptional()
  @IsString()
  timezone?: string;

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
  deliveryLead?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  hoursPerCycle?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateEngagementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: SERVICE_TIERS })
  @IsOptional()
  @IsIn(SERVICE_TIERS as unknown as string[])
  serviceTier?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;

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
  deliveryLead?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  hoursPerCycle?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

/** Dedicated action so pause/resume always carries a reason and cannot be
 * done through a bare status PATCH — see design_plan §7.6 pause policy. */
export class SetEngagementStatusDto {
  @ApiProperty({ enum: ENGAGEMENT_STATUSES })
  @IsIn(ENGAGEMENT_STATUSES as unknown as string[])
  status: string;

  @ApiPropertyOptional({ description: 'Required when pausing — why future committed work stops auto-progressing.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
