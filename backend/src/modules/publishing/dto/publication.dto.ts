/**
 * DTOs for publications — `/api/projects/:projectId/publications`.
 *
 * `contentHash` on create is the guard for design_plan §11.2 case 10: an
 * operator sends the hash of the revision they reviewed, and if the content has
 * moved on since, the create fails with 409 instead of publishing something
 * nobody approved. It is optional because a caller may legitimately not have
 * read the revision first — but the approval gate still applies either way.
 *
 * @module publishing/dto/publication.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { PUBLICATION_MODES, PUBLICATION_STATUSES } from '../publishing.types';

const MODE_LIST = PUBLICATION_MODES as unknown as string[];

export class CreatePublicationDto {
  @ApiProperty({ description: 'The GrowthAsset being published.', example: 'clx1a2b3c' })
  @IsString()
  @MinLength(1)
  assetId: string;

  @ApiPropertyOptional({
    description:
      'The exact revision to publish. Omit for the asset\'s latest revision — which must itself be the approved one, or the create fails.',
  })
  @IsOptional()
  @IsString()
  revisionId?: string;

  @ApiProperty({ description: 'The connected destination to publish to.' })
  @IsString()
  @MinLength(1)
  destinationId: string;

  @ApiPropertyOptional({ enum: MODE_LIST, default: 'draft', description: '`draft` creates a draft remotely; `publish` puts it live.' })
  @IsOptional()
  @IsIn(MODE_LIST)
  mode?: string;

  @ApiPropertyOptional({
    description:
      'When to publish, resolved in the project/engagement timezone: an ISO timestamp with an offset, a bare date, or a local date-time. Omit to dispatch immediately.',
    example: '2026-09-20T09:00',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  scheduledFor?: string;

  @ApiProperty({
    description: 'The scopes this push is authorized to use. Must be a subset of what the destination was granted.',
    type: [String],
    example: ['content:write'],
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  permissions: string[];

  @ApiPropertyOptional({ description: 'Override the destination\'s resource for this one publication.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  resourceId?: string;

  @ApiPropertyOptional({
    description:
      'The `contentHash` of the revision you reviewed. If the revision has changed since, this is refused with 409 rather than publishing unreviewed content.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  contentHash?: string;
}

export class CancelPublicationDto {
  @ApiProperty({ description: 'Why it is being cancelled. Recorded on the audit trail.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class RetryPublicationDto {
  @ApiPropertyOptional({ description: 'Why a retry is warranted, for the audit trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Required only when retrying a row stuck in `publishing`: confirms you checked the remote system and there is no copy of this content there, because the interrupted attempt may have succeeded.',
  })
  @IsOptional()
  @IsBoolean()
  confirmNoRemoteCopy?: boolean;
}

export class ListPublicationsQueryDto {
  @ApiPropertyOptional({ enum: PUBLICATION_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(PUBLICATION_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destinationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetId?: string;

  @ApiPropertyOptional({ description: 'Max rows (default 50, cap 200).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
