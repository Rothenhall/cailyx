/**
 * DTOs for the Findings module (FR-9).
 *
 * @module findings.dto
 */

import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class GenerateFindingsDto {
  /** Max findings to generate per batch (default 5, hard-capped at 10). */
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  limit?: number;
}