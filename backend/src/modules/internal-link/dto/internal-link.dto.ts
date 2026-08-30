/**
 * DTOs for the Internal-Link module (Agent #8, Swarm layer).
 *
 * @module internal-link.dto
 */

import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { INTERNAL_LINK_LIMITS } from '../internal-link.types';

const L = INTERNAL_LINK_LIMITS;

export class AnalyzeLinkGraphDto {
  /** Crawl root. Defaults to `https://<project.domain>`. `fixture://demo` is
   * accepted only when INTERNAL_LINK_ALLOW_FIXTURE=1 (offline smoke). */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  rootUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(L.maxPages.min)
  @Max(L.maxPages.max)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(L.maxDepth.min)
  @Max(L.maxDepth.max)
  maxDepth?: number;

  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}

export class UpdateRecommendationDto {
  @IsIn(['open', 'applied', 'dismissed'])
  status: string;
}
