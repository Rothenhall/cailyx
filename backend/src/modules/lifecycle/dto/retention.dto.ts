/**
 * DTOs for retention policy reads/updates and the preview/apply pair —
 * `/api/retention-policies`.
 *
 * @module dto/retention.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RETENTION_ACTIONS } from '../lifecycle.types';

export class UpdateRetentionPolicyDto {
  @ApiPropertyOptional({ description: 'Retention window in days. Null means "no window" — the policy never matches anything, which is different from a window of 0.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  retainDays?: number;

  @ApiPropertyOptional({ enum: RETENTION_ACTIONS, description: 'What the policy does to rows older than the window. `delete` is refused for `activity`: the audit trail is retained under policy.' })
  @IsOptional()
  @IsIn(RETENTION_ACTIONS as unknown as string[])
  action?: string;

  @ApiPropertyOptional({ description: 'Whether the policy runs. A disabled policy is still a stored intention, and is reported as disabled rather than absent.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * A retention run is destructive, so it is preview-then-apply. `confirm` is
 * required on apply: an endpoint that deletes rows on a bare POST is one
 * mistyped URL away from a data loss, and the preview cannot protect against a
 * call that never happened.
 */
export class ApplyRetentionDto {
  @ApiProperty({ description: 'Must be literally true. The apply refuses without it, so a destructive run is never the default reading of a request.' })
  @IsBoolean()
  confirm: boolean;

  @ApiPropertyOptional({ description: 'Why this retention run was applied. Recorded on the audit event.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
