/**
 * DTOs for the Google integration.
 *
 * @module google/dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const SERVICES = ['search-console', 'analytics'] as const;

export class AuthorizeDto {
  @ApiProperty({ enum: SERVICES })
  @IsIn(SERVICES as unknown as string[])
  service!: 'search-console' | 'analytics';

  @ApiPropertyOptional({ description: 'Project to associate the resource picker with, if any.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectId?: string;
}

export class SetResourceDto {
  @ApiProperty({ enum: SERVICES })
  @IsIn(SERVICES as unknown as string[])
  service!: 'search-console' | 'analytics';

  @ApiProperty({ description: 'Project the resource is being mapped to.' })
  @IsString()
  @MaxLength(64)
  projectId!: string;

  @ApiProperty({ description: 'GSC siteUrl, or GA4 "properties/123456789".' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  resourceId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  resourceLabel?: string;
}

export class SummaryQueryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  projectId!: string;

  @ApiPropertyOptional({ description: 'Rolling window in days (1-90).', default: 28 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

export class ResourcesQueryDto {
  @ApiProperty({ enum: SERVICES })
  @IsIn(SERVICES as unknown as string[])
  service!: 'search-console' | 'analytics';

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  projectId!: string;
}
