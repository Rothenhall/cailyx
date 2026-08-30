/**
 * DTOs for the Sleeper Refresh module (SOP-10).
 *
 * @module sleeper-refresh.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSleeperPageDto {
  @ApiProperty({ description: 'Page URL' })
  @IsString()
  @MinLength(9)
  @MaxLength(2000)
  url: string;

  @ApiPropertyOptional({ description: 'Human label' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ description: 'Traffic decline % (positive = declined)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  trafficDeclinePct?: number;

  @ApiPropertyOptional({ description: 'Referring-domain count' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  referringDomains?: number;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ImportSleeperDto {
  @ApiPropertyOptional({ description: 'Pasted GSC CSV/TSV export (url, declinePct[, referringDomains] per row; header row auto-skipped)' })
  @IsOptional()
  @IsString()
  @MaxLength(1_000_000)
  text?: string;

  @ApiPropertyOptional({ description: 'Structured rows (alternative to text)' })
  @IsOptional()
  pages?: Array<{ url: string; trafficDeclinePct?: number; referringDomains?: number }>;
}

export class ListSleeperQueryDto {
  @ApiPropertyOptional({ description: 'Min decline % to count as sleeper (default 20)', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  minDeclinePct?: number;

  @ApiPropertyOptional({ description: 'Minimum referring domains (default 3)', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minReferringDomains?: number;

  @ApiPropertyOptional({ description: 'Filter by refresh status', enum: ['flagged', 'brief-sent', 'in-progress', 'refreshed', 'abandoned'] })
  @IsOptional()
  @IsIn(['flagged', 'brief-sent', 'in-progress', 'refreshed', 'abandoned'])
  status?: string;
}

export class UpdateSleeperPageDto {
  @ApiPropertyOptional({ description: 'Refresh lifecycle', enum: ['flagged', 'brief-sent', 'in-progress', 'refreshed', 'abandoned'] })
  @IsOptional()
  @IsIn(['flagged', 'brief-sent', 'in-progress', 'refreshed', 'abandoned'])
  status?: string;

  @ApiPropertyOptional({ description: 'Label' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ description: 'Traffic decline %' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  trafficDeclinePct?: number;

  @ApiPropertyOptional({ description: 'Referring-domain count' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  referringDomains?: number;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Visible dateModified BEFORE the refresh' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  dateModifiedBefore?: string;
}

export class MarkRefreshedDto {
  @ApiProperty({ description: 'Visible dateModified AFTER the refresh (audits the SLA)' })
  @IsString()
  @MinLength(4)
  @MaxLength(60)
  dateModifiedAfter: string;

  @ApiPropertyOptional({ description: 'Closing notes' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}