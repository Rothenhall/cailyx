/**
 * Upgrade DTOs (FR-11.4 — Stripe Checkout option A).
 *
 * @module upgrade.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { UPGRADE_STATUSES, UPGRADE_TIERS } from '../delivery.types';

export class CreateUpgradeDto {
  @ApiProperty({ description: 'Checkout tier', enum: UPGRADE_TIERS, example: 'full' })
  @IsIn(UPGRADE_TIERS)
  tier: string;

  @ApiPropertyOptional({ description: 'Lead whose checkout click should be logged' })
  @IsOptional()
  @IsString()
  leadId?: string;
}

export class UpdateUpgradeDto {
  @ApiPropertyOptional({ description: 'Lifecycle (clicked → completed via the webhook stand-in)', enum: UPGRADE_STATUSES })
  @IsOptional()
  @IsIn(UPGRADE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Stripe checkout session id (on completion)' })
  @IsOptional()
  @IsString()
  stripeSessionId?: string;
}