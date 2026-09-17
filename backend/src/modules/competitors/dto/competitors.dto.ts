/**
 * DTOs for the Competitors module.
 *
 * @module competitors.dto
 */

import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

/**
 * One competitor to promote/attach on a `/discover` call. Both an operator
 * supplying a fresh list and the module's own read of `Project.competitors`
 * (JSON) end up going through this same shape.
 */
export class CompetitorInputDto {
  @ApiProperty({ description: 'Display name', example: 'Acme Corp' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    description: 'Bare domain. Omit when only the name is known — the competitor row is still created, but no homepage crawl can run against it.',
    example: 'acme.com',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  domain?: string;
}

/**
 * Request body for POST /projects/:projectId/competitors/discover.
 */
export class DiscoverCompetitorsDto {
  /**
   * Optional explicit list. Always merged with whatever is already on
   * `Project.competitors` (JSON) rather than replacing it — an entry already
   * present there is enriched (e.g. a domain filled in) rather than
   * duplicated. Omit entirely to just promote + (re)profile the existing
   * JSON list.
   */
  @ApiPropertyOptional({
    type: [CompetitorInputDto],
    description:
      "Competitors to add on top of Project.competitors (JSON), e.g. ones an operator knows about that were never seeded by intake. Omit to just promote and (re)profile whatever is already on the project.",
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompetitorInputDto)
  competitors?: CompetitorInputDto[];
}

/**
 * Request body for POST /projects/:projectId/competitors/discover/market
 * (§12.2 — service/market-based discovery).
 */
export class DiscoverByMarketDto {
  /**
   * When false/omitted (the default), discovery only mines names/domains
   * already present in stored AEO verdicts and SERP snapshots — free, no
   * vendor call. When true, it additionally composes a small bounded set of
   * Google searches (confirmed services x confirmed target markets) through
   * the gated SERP provider — an explicit, budgeted "Collect new results"
   * action, never triggered by a page load.
   */
  @ApiPropertyOptional({
    description:
      'When true, also runs a bounded set of fresh Google searches (services x markets) through the gated SERP provider — a paid/explicit action. Default false: mine only what is already stored.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  collectNew?: boolean;

  /**
   * Only meaningful with collectNew=true. Lets a caller force the offline
   * `fixture` provider (SERP_ALLOW_FIXTURE=1) — used by the smoke harness so
   * this action can be proven without a vendor account or real spend.
   */
  @ApiPropertyOptional({ enum: ['dataforseo', 'fixture'], description: 'SERP provider override for the bounded search pass.' })
  @IsOptional()
  @IsIn(['dataforseo', 'fixture'])
  provider?: 'dataforseo' | 'fixture';
}

/** Request body for PATCH /projects/:projectId/competitors/candidates/:competitorId/relevance. */
export class SetCandidateRelevanceDto {
  @ApiProperty({ enum: ['direct-competitor', 'adjacent-alternative', 'not-relevant'] })
  @IsString()
  @IsIn(['direct-competitor', 'adjacent-alternative', 'not-relevant'])
  relevance!: 'direct-competitor' | 'adjacent-alternative' | 'not-relevant';
}
