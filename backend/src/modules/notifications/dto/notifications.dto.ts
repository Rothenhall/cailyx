/**
 * DTOs for the Notifications module (G08).
 *
 * @module notifications.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export const NOTIFICATION_KINDS = [
  'work-assigned',
  'approval-requested',
  'report-released',
  'run-failed',
  'message-received',
  'alert-raised',
  'request-due',
] as const;

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ description: 'Only unread rows when true.' })
  @IsOptional()
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  // Query strings arrive as strings; without this every request
  // carrying the field fails @IsInt validation.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor from a previous response.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class UpsertNotificationPreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_KINDS })
  @IsIn(NOTIFICATION_KINDS)
  kind: (typeof NOTIFICATION_KINDS)[number];

  @ApiProperty()
  @IsBoolean()
  inApp: boolean;

  @ApiProperty()
  @IsBoolean()
  email: boolean;
}

export class PutNotificationPreferencesDto {
  @ApiProperty({ type: [UpsertNotificationPreferenceDto] })
  preferences: UpsertNotificationPreferenceDto[];
}

export class UploadAttachmentDto {
  @ApiProperty({ example: 'brief-v2.pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(127)
  mimeType: string;

  @ApiProperty({ description: 'File content, base64-encoded. No multipart upload backend is wired up; this is the whole file body.' })
  @IsString()
  @MinLength(1)
  contentBase64: string;

  @ApiPropertyOptional({ description: 'message | work-item | report | content | onboarding-request', default: 'message' })
  @IsOptional()
  @IsIn(['message', 'work-item', 'report', 'content', 'onboarding-request'])
  contextType?: string;

  @ApiPropertyOptional({ description: 'The id of the message/work-item/etc this attachment is attached to, if any.' })
  @IsOptional()
  @IsString()
  contextId?: string;

  @ApiPropertyOptional({ description: 'Scope this file to a client (defaults to the project\'s client if omitted).' })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ enum: ['operator-only', 'client-visible'], default: 'operator-only' })
  @IsOptional()
  @IsIn(['operator-only', 'client-visible'])
  visibility?: string;
}

export class MarkReadCursorDto {
  @ApiPropertyOptional({ description: 'The id of the last message the caller has read. Omit to mark the whole thread read as of now.' })
  @IsOptional()
  @IsString()
  lastReadMessageId?: string;
}

export class ThreadQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  // Query strings arrive as strings; without this every request
  // carrying the field fails @IsInt validation.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor (a message id) from a previous response — returns older messages.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Restrict to one project\'s messages.' })
  @IsOptional()
  @IsString()
  projectId?: string;
}
