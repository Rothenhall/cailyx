/**
 * DTOs for the Entity Audit module.
 *
 * Validated with class-validator + documented via @ApiProperty for Swagger.
 *
 * @module entity-audit.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsIn, IsUrl, MaxLength } from 'class-validator';

export class CreateEntityDto {
  @ApiProperty({ description: 'Entity display name', example: 'Rothenhall Partners' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ description: 'One-line descriptor of the entity', example: 'AI visibility consultancy for B2B' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  descriptor?: string;

  @ApiProperty({ enum: ['brand', 'product', 'founder', 'metric'], description: 'Entity type' })
  @IsIn(['brand', 'product', 'founder', 'metric'])
  type: string;
}

export class UpdateEntityDto {
  @ApiPropertyOptional({ description: 'Updated display name', example: 'Rothenhall Partners Ltd' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Updated descriptor', example: 'AI visibility consultancy' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  descriptor?: string;

  @ApiPropertyOptional({ enum: ['brand', 'product', 'founder', 'metric'] })
  @IsIn(['brand', 'product', 'founder', 'metric'])
  @IsOptional()
  type?: string;
}

export class CreatePlatformRecordDto {
  @ApiProperty({ enum: ['linkedin', 'g2', 'crunchbase', 'other'], description: 'Platform identifier' })
  @IsIn(['linkedin', 'g2', 'crunchbase', 'other'])
  platform: string;

  @ApiPropertyOptional({ description: 'Name as shown on the platform', example: 'Rothenhall Partners' })
  @IsString()
  @IsOptional()
  @MaxLength(300)
  recordedName?: string;

  @ApiPropertyOptional({ description: 'Descriptor/tagline as shown on the platform' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  recordedDescriptor?: string;

  @ApiPropertyOptional({ description: 'Source URL for semi-auto fetch (single page)', example: 'https://linkedin.com/company/rothenhall' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @IsOptional()
  sourceUrl?: string;

  @ApiPropertyOptional({ enum: ['match', 'mismatch', 'not-checked'], default: 'not-checked' })
  @IsIn(['match', 'mismatch', 'not-checked'])
  @IsOptional()
  consistencyStatus?: string;

  @ApiPropertyOptional({ description: 'If true and sourceUrl is set, fetch the page and auto-verify title match (semi-auto mode, low ToS risk — single page fetch)', default: false })
  @IsOptional()
  verifySource?: boolean;
}

export class UpdatePlatformRecordDto {
  @ApiPropertyOptional({ enum: ['linkedin', 'g2', 'crunchbase', 'other'] })
  @IsIn(['linkedin', 'g2', 'crunchbase', 'other'])
  @IsOptional()
  platform?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  recordedName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  recordedDescriptor?: string;

  @ApiPropertyOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @IsOptional()
  sourceUrl?: string;

  @ApiPropertyOptional({ enum: ['match', 'mismatch', 'not-checked'] })
  @IsIn(['match', 'mismatch', 'not-checked'])
  @IsOptional()
  consistencyStatus?: string;
}

export class RunSchemaCheckDto {
  @ApiProperty({ description: 'URL to fetch and extract JSON-LD from', example: 'https://example.com' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url: string;
}
