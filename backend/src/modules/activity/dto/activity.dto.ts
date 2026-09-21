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
  // C1 (2026-09-20, docs/analysis/client-portal.md §15) — the admin
  // "waive Google-connect onboarding gate" action. A distinct verb rather than
  // reusing "updated" so the audit trail (and any future admin-facing filter
  // UI) can find every waive event directly, since §33 names the waive action
  // explicitly as one of the sensitive actions this shared log must cover.
  'waived',
  // C5 (2026-09-21, docs/analysis/client-portal.md §5/§23/§30/§32) — client
  // suspend/reactivate (admin action or the payment-failure grace-period
  // sweep acting as the "system" actor) and primary-contact/ownership
  // transfer. Distinct verbs so the audit trail can filter these directly.
  'suspended',
  'reactivated',
  'ownership-transferred',
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
