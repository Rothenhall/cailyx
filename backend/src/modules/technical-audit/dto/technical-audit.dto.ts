/**
 * DTOs for the Technical Audit module.
 *
 * Uses class-validator for input validation (prevents SSRF via @IsUrl)
 * and class-transformer for payload transformation.
 *
 * @module technical-audit.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUrl, IsOptional, IsIn, IsNotEmpty, IsInt, Min, Max } from 'class-validator';

/**
 * Request body for POST /projects/:projectId/technical-audit/run
 */
export class RunAuditDto {
  /**
   * Optional. Omit it and the audit runs against the project's own domain —
   * which is what the console does, so an operator never types their own URL.
   * Supplying one is for auditing a specific path (a landing page, a staging
   * host) rather than the site root.
   */
  @ApiPropertyOptional({
    description: "Target URL. Defaults to the project's own domain when omitted.",
    example: 'https://example.com',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_protocol: true, require_valid_protocol: true, protocols: ['http', 'https'] })
  targetUrl?: string;

  /**
   * Optional per-run override of how many sitemap URLs to crawl. Bounded
   * server-side — an unbounded crawl is a denial-of-wallet on our own fetcher.
   */
  @ApiPropertyOptional({ description: 'Max sitemap URLs to crawl this run (1-1000)', example: 150 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  pageBudget?: number;
}

/**
 * Request body for PUT /projects/:projectId/technical-audit/schedule
 */
export class SetScheduleDto {
  @ApiProperty({
    enum: ['daily', 'weekly', 'monthly', 'manual-only'],
    description: 'Scheduling cadence for recurring audits',
  })
  @IsIn(['daily', 'weekly', 'monthly', 'manual-only'])
  cadence: 'daily' | 'weekly' | 'monthly' | 'manual-only';
}