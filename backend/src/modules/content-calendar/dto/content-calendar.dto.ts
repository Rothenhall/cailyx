/**
 * DTOs for the content calendar (P10, platform_improvement_plan.md §6.7).
 *
 * §6.7 asks for a *bounded* read: `from`, `to`, `timezone`, project/portfolio
 * scope, `type`, `state`, and cursor pagination. Every one of those is a field
 * here rather than a convention, because an unbounded calendar read is exactly
 * the thing that lets a month look empty.
 *
 * @module content-calendar.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  CALENDAR_CHANNELS,
  CALENDAR_CONTENT_TYPES,
  DELIVERY_MODES,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_UNSCHEDULED_LIMIT,
  MAX_EVENT_LIMIT,
  MAX_UNSCHEDULED_LIMIT,
  SCHEDULE_STATES,
} from '../content-calendar.types';

const MAX_LENGTH_CURSOR = 200;

/** Bounds shared by every calendar read — §6.7's "bounded from, to, timezone". */
export class CalendarWindowQueryDto {
  @ApiPropertyOptional({
    description:
      'Window start. A YYYY-MM-DD date is read as local midnight on that day in `timezone`; a full ISO timestamp is used as an instant. Defaults to the first day of the current month in `timezone`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @ApiPropertyOptional({
    description:
      'Window end, inclusive. A YYYY-MM-DD date is read as the last instant of that day in `timezone`. Defaults to the last day of the month `from` falls in.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @ApiPropertyOptional({
    description:
      "IANA zone the window and every response time is expressed in. Defaults to the project's engagement timezone (portfolio scope: UTC).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

/** Staff calendar reads (project and portfolio scope). */
export class ListCalendarQueryDto extends CalendarWindowQueryDto {
  @ApiPropertyOptional({ enum: CALENDAR_CONTENT_TYPES as unknown as string[] })
  @IsOptional()
  @IsIn(CALENDAR_CONTENT_TYPES as unknown as string[])
  type?: string;

  @ApiPropertyOptional({ enum: CALENDAR_CHANNELS as unknown as string[] })
  @IsOptional()
  @IsIn(CALENDAR_CHANNELS as unknown as string[])
  channel?: string;

  @ApiPropertyOptional({
    enum: SCHEDULE_STATES as unknown as string[],
    description: 'Derived schedule state. Filtering by state is evaluated exactly, never approximated (see the module README).',
  })
  @IsOptional()
  @IsIn(SCHEDULE_STATES as unknown as string[])
  state?: string;

  @ApiPropertyOptional({ description: 'Staff owner of the placement.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerId?: string;

  @ApiPropertyOptional({ description: 'Portfolio scope only — narrow to one project.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectId?: string;

  @ApiPropertyOptional({ description: `Events per page (default ${DEFAULT_EVENT_LIMIT}, max ${MAX_EVENT_LIMIT}).` })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_EVENT_LIMIT)
  limit?: number = DEFAULT_EVENT_LIMIT;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous response.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LENGTH_CURSOR)
  cursor?: string;

  @ApiPropertyOptional({ description: `Unscheduled items per page (default ${DEFAULT_UNSCHEDULED_LIMIT}).` })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNSCHEDULED_LIMIT)
  unscheduledLimit?: number = DEFAULT_UNSCHEDULED_LIMIT;

  @ApiPropertyOptional({ description: 'Opaque cursor for the unscheduled list.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LENGTH_CURSOR)
  unscheduledCursor?: string;
}

/** Client portal calendar read. Same window, but no owner filter and no internal fields. */
export class PortalCalendarQueryDto extends CalendarWindowQueryDto {
  @ApiPropertyOptional({ enum: CALENDAR_CONTENT_TYPES as unknown as string[] })
  @IsOptional()
  @IsIn(CALENDAR_CONTENT_TYPES as unknown as string[])
  type?: string;

  @ApiPropertyOptional({ enum: CALENDAR_CHANNELS as unknown as string[] })
  @IsOptional()
  @IsIn(CALENDAR_CHANNELS as unknown as string[])
  channel?: string;

  @ApiPropertyOptional({ enum: SCHEDULE_STATES as unknown as string[] })
  @IsOptional()
  @IsIn(SCHEDULE_STATES as unknown as string[])
  state?: string;

  @ApiPropertyOptional({ description: `Events per page (default ${DEFAULT_EVENT_LIMIT}, max ${MAX_EVENT_LIMIT}).` })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_EVENT_LIMIT)
  limit?: number = DEFAULT_EVENT_LIMIT;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LENGTH_CURSOR)
  cursor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNSCHEDULED_LIMIT)
  unscheduledLimit?: number = DEFAULT_UNSCHEDULED_LIMIT;
}

/**
 * Create a placement — the *intention*, before any approval exists.
 *
 * Nothing about this body mentions an approval or a revision: that is the whole
 * point of §6.6's split. The piece has to exist (`assetId`), and if the caller
 * wants this to be pushed automatically they must name a destination that is
 * actually connected.
 */
export class CreatePlacementDto {
  @ApiProperty({ description: 'GrowthAsset.id — the content piece this placement is for.' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  assetId!: string;

  @ApiPropertyOptional({ description: 'ContentBrief.id when the piece came from a brief family.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  briefId?: string;

  @ApiPropertyOptional({ description: 'Plan Commitment.id this placement serves. Reference only — nothing propagates.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  commitmentId?: string;

  @ApiPropertyOptional({
    enum: CALENDAR_CONTENT_TYPES as unknown as string[],
    description: "Defaults to the piece's own asset type mapped onto this calendar's vocabulary.",
  })
  @IsOptional()
  @IsIn(CALENDAR_CONTENT_TYPES as unknown as string[])
  contentType?: string;

  @ApiProperty({ enum: CALENDAR_CHANNELS as unknown as string[] })
  @IsIn(CALENDAR_CHANNELS as unknown as string[])
  channel!: string;

  @ApiPropertyOptional({ enum: DELIVERY_MODES as unknown as string[] })
  @IsOptional()
  @IsIn(DELIVERY_MODES as unknown as string[])
  deliveryMode?: string;

  @ApiPropertyOptional({ description: 'Required when deliveryMode is "automated".' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  destinationId?: string;

  @ApiProperty({
    description:
      'The intended local time: YYYY-MM-DD (09:00 local), YYYY-MM-DDTHH:mm read in `timezone`, or a full ISO timestamp.',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  scheduledFor!: string;

  @ApiPropertyOptional({ description: "Defaults to the project's engagement timezone." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    enum: ['earlier', 'later'],
    description: 'Required only when the local time is repeated by a fall-back DST transition.',
  })
  @IsOptional()
  @IsIn(['earlier', 'later'])
  dstDisambiguation?: 'earlier' | 'later';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerId?: string;

  @ApiPropertyOptional({
    description: 'Client-supplied dedupe key. A retry with the same key returns the existing placement.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9._:-]+$/, { message: 'idempotencyKey may contain letters, digits, dot, colon, underscore and dash.' })
  idempotencyKey?: string;
}

export class UpdatePlacementDto {
  @ApiProperty({ description: 'The version you read. A stale version is refused rather than silently overwriting.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  @ApiPropertyOptional({
    description: 'New intended local time. Changing this never moves a queued publication — see the module README.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  scheduledFor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ enum: ['earlier', 'later'] })
  @IsOptional()
  @IsIn(['earlier', 'later'])
  dstDisambiguation?: 'earlier' | 'later';

  @ApiPropertyOptional({ enum: CALENDAR_CHANNELS as unknown as string[] })
  @IsOptional()
  @IsIn(CALENDAR_CHANNELS as unknown as string[])
  channel?: string;

  @ApiPropertyOptional({ enum: DELIVERY_MODES as unknown as string[] })
  @IsOptional()
  @IsIn(DELIVERY_MODES as unknown as string[])
  deliveryMode?: string;

  @ApiPropertyOptional({ description: 'Send null to clear the destination (manual delivery).' })
  @IsOptional()
  destinationId?: string | null;

  @ApiPropertyOptional({ enum: CALENDAR_CONTENT_TYPES as unknown as string[] })
  @IsOptional()
  @IsIn(CALENDAR_CONTENT_TYPES as unknown as string[])
  contentType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  commitmentId?: string | null;
}

export class CancelPlacementDto {
  @ApiProperty({ description: 'Why it is no longer intended. Kept with the row — cancellation never deletes.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: 'The version you read.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * Link this placement to an approved revision.
 *
 * Deliberately thin: every gate that makes a publication legal lives in
 * publishing, and this body only carries what publishing's own
 * `CreatePublicationDto` carries. In particular it cannot name a different
 * asset — the placement already names one — so a caller cannot use the
 * calendar to publish something else.
 */
export class LinkPublicationDto {
  @ApiPropertyOptional({ description: 'Exact revision to publish. Defaults to the latest.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  revisionId?: string;

  @ApiPropertyOptional({ enum: ['draft', 'publish'], default: 'publish' })
  @IsOptional()
  @IsIn(['draft', 'publish'])
  mode?: 'draft' | 'publish';

  @ApiProperty({
    description: "Scopes to request on the destination, validated against that provider's declared scopes.",
    type: [String],
  })
  @IsOptional()
  permissions?: string[];

  @ApiPropertyOptional({ description: 'The content hash you reviewed. A mismatch is refused (publishing gate).' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  contentHash?: string;

  @ApiPropertyOptional({
    description:
      'Set true to dispatch immediately instead of at the placement time. Refused for a placement in the past.',
  })
  @IsOptional()
  @IsBoolean()
  publishNow?: boolean;
}
