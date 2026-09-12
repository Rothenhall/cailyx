/**
 * DTOs for the Tech Stack module.
 *
 * @module tech-stack.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Request body for POST /projects/:projectId/tech-stack/scan
 */
export class RunTechStackScanDto {
  /**
   * Optional. Omit it and the scan runs against the project's own domain.
   * Supplying one lets the same endpoint profile a competitor's domain
   * (wave-6 step 6 reuses this unchanged) without needing a project of its own.
   */
  @ApiPropertyOptional({
    description: "Bare domain to scan. Defaults to the project's own domain when omitted.",
    example: 'example.com',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  domain?: string;
}
