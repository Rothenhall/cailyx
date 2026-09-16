/**
 * DTOs for the Activity module (G15).
 *
 * @module activity.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const ACTIVITY_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'released',
  'approved',
  'rejected',
  'published',
  'sent',
  'started',
  'cancelled',
  'granted',
  'revoked',
  'logged-in',
] as const;

export class ListActivityQueryDto {
  @ApiPropertyOptional({ description: 'Filter to one resource type, e.g. "report", "work-item", "budget-policy".' })
  @IsOptional()
  @IsString()
  resourceType?: string;

  @ApiPropertyOptional({ description: 'Filter to one resource id.' })
  @IsOptional()
  @IsString()
  resourceId?: string;

  @ApiPropertyOptional({ enum: ACTIVITY_ACTIONS })
  @IsOptional()
  @IsIn(ACTIVITY_ACTIONS)
  action?: (typeof ACTIVITY_ACTIONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  // A query string is always a string on the wire. Without this coercion
  // @IsInt rejects every request that carries `limit` at all.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor from a previous response.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
