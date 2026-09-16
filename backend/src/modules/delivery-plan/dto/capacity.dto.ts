/**
 * DTOs for CapacityAllocation and Milestone CRUD.
 *
 * @module dto/capacity.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { ABSENCE_KINDS, MILESTONE_STATUSES } from '../delivery-plan.types';

export class CreateCapacityAllocationDto {
  @ApiProperty({ description: 'User.id this allocation is for.' })
  @IsString()
  userId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiProperty()
  @IsISO8601()
  startsOn: string;

  @ApiProperty()
  @IsISO8601()
  endsOn: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  availableHours?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  allocatedHours?: number;

  @ApiPropertyOptional({ enum: ABSENCE_KINDS })
  @IsOptional()
  @IsIn(ABSENCE_KINDS as unknown as string[])
  absenceKind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdateCapacityAllocationDto {
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
  @IsNumber()
  @Min(0)
  availableHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  allocatedHours?: number;

  @ApiPropertyOptional({ enum: ABSENCE_KINDS })
  @IsOptional()
  @IsIn(ABSENCE_KINDS as unknown as string[])
  absenceKind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CreateMilestoneDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ description: 'Engagement this milestone belongs to, for timezone resolution.' })
  @IsOptional()
  @IsString()
  engagementId?: string;

  @ApiPropertyOptional({ description: 'Bare date or full ISO timestamp.' })
  @IsOptional()
  @IsString()
  dueOn?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;
}

export class UpdateMilestoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  dueOn?: string;

  @ApiPropertyOptional({ enum: MILESTONE_STATUSES })
  @IsOptional()
  @IsIn(MILESTONE_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;
}
