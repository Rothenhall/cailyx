/**
 * DTOs for the Backlinks module.
 *
 * @module backlinks.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class RefreshBacklinksDto {
  @ApiPropertyOptional({ description: 'Domain/subdomain/page to query. Defaults to the project\'s own domain.' })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  target?: string;

  @ApiPropertyOptional({ description: 'How many individual backlinks to sample, ranked by authority. Defaults to 10, capped at 100.' })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sampleLimit?: number;
}
