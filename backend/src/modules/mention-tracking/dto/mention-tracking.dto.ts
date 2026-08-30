/**
 * DTOs for the Mention Tracking module (SOP-7).
 *
 * @module mention-tracking.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCampaignDto {
  @ApiProperty({ description: 'Campaign name', example: 'Best-of AI visibility listicles' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ description: 'The "best X" hunt query this campaign uses' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  listicleQuery?: string;
}

export class CreateTargetDto {
  @ApiProperty({ description: 'Candidate page URL', example: 'https://blog.example.com/best-ai-visibility-tools' })
  @IsString()
  @MinLength(9)
  @MaxLength(2000)
  url: string;

  @ApiPropertyOptional({ description: 'Target kind', enum: ['listicle', 'community', 'review', 'other'], default: 'listicle' })
  @IsOptional()
  @IsIn(['listicle', 'community', 'review', 'other'])
  type?: string;

  @ApiPropertyOptional({ description: 'Human label, e.g. page title' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ description: 'Optional campaign to attach to' })
  @IsOptional()
  @IsString()
  campaignId?: string;

  @ApiPropertyOptional({ description: 'Free-form outreach notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateTargetDto {
  @ApiPropertyOptional({ description: 'New label' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ description: 'Outreach lifecycle', enum: ['new', 'contacted', 'replied', 'placed', 'rejected'] })
  @IsOptional()
  @IsIn(['new', 'contacted', 'replied', 'placed', 'rejected'])
  status?: string;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CheckTargetDto {
  @ApiProperty({ description: 'Client brand token to search the page for', example: 'Wave3Co' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  brandToken: string;
}

export class DecayQueryDto {
  @ApiProperty({ description: 'Client brand token decay is tracked for', example: 'Wave3Co' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  brandToken: string;
}

export class ListTargetsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by outreach status', enum: ['new', 'contacted', 'replied', 'placed', 'rejected'] })
  @IsOptional()
  @IsIn(['new', 'contacted', 'replied', 'placed', 'rejected'])
  status?: string;
}