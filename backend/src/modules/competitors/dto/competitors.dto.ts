/**
 * DTOs for the Competitors module.
 *
 * @module competitors.dto
 */

import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

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
