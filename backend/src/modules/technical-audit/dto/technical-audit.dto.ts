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
 * Ceiling for {@link RunAuditDto.pageBudget}. Exported so the service clamps a
 * scheduled-path budget to the same value the DTO validates — the two entry
 * points into `runAudit` must agree on the bound.
 */
export const MAX_PAGE_BUDGET = 1000;

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
   *
   * Forwarded into the queued job's data and applied by the worker to this
   * run's page-inventory crawl (G19/D16). Omit it and the run uses
   * `technicalAudit.pageCrawlBudget` (env `TA_PAGE_CRAWL_BUDGET`).
   */
  @ApiPropertyOptional({
    description:
      'Max sitemap URLs to crawl for THIS run (1-1000). Omit to use the server default (TA_PAGE_CRAWL_BUDGET).',
    example: 150,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_BUDGET)
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