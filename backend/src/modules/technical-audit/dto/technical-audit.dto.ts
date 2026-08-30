/**
 * DTOs for the Technical Audit module.
 *
 * Uses class-validator for input validation (prevents SSRF via @IsUrl)
 * and class-transformer for payload transformation.
 *
 * @module technical-audit.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUrl, IsOptional, IsIn, IsNotEmpty } from 'class-validator';

/**
 * Request body for POST /projects/:projectId/technical-audit/run
 */
export class RunAuditDto {
  @ApiProperty({ description: 'Target URL to audit', example: 'https://example.com' })
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_protocol: true, require_valid_protocol: true, protocols: ['http', 'https'] })
  targetUrl: string;
}

/**
 * Request body for PUT /projects/:projectId/technical-audit/schedule
 */
export class SetScheduleDto {
  @ApiProperty({ enum: ['weekly', 'monthly', 'manual-only'], description: 'Scheduling cadence' })
  @IsIn(['weekly', 'monthly', 'manual-only'])
  cadence: 'weekly' | 'monthly' | 'manual-only';
}