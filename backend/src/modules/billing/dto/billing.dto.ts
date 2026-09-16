/**
 * Request DTOs for G16 — offers, entitlements and the public intake.
 *
 * Two rules shape this file:
 *
 * 1. **No caller-supplied money or paid status.** There is no `amountPaid`,
 *    `status: 'paid'` or `entitlements` field on any *public* DTO. The only
 *    place an entitlement key list appears is `CreateOfferDto`/`UpdateOfferDto`,
 *    which are admin-only: the price mapping is server-side, in `Offer`.
 * 2. **Consent is a required boolean, not a checkbox we assume.** `consent`
 *    must be `true` for any submission carrying contact details; the service
 *    checks it explicitly so the error message can state what was agreed to.
 *
 * @module billing/dto/billing.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  CHECKOUT_SESSION_ID_RE,
  ENTITLEMENT_STATUSES,
  OFFER_CODE_RE,
  OFFER_INTERVALS,
  PAYMENT_EVENT_STATUSES,
  SUBSCRIPTION_STATUSES,
  SUPPORTED_CURRENCIES,
} from '../billing.types';

const INTERVAL_LIST = OFFER_INTERVALS as unknown as string[];

// ── Offers (admin) ───────────────────────────────────────────────────────

export class CreateOfferDto {
  @ApiProperty({ description: 'Stable slug quoted in checkout metadata, e.g. `monitoring-monthly`.', example: 'monitoring-monthly' })
  @IsString()
  @Matches(OFFER_CODE_RE, { message: 'code must be a lowercase slug (letters, digits, . _ -), 2-64 characters' })
  code: string;

  @ApiProperty({ example: 'Monitoring' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Provider price id (`price_...`). The second server-side mapping key after `code`.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerPriceId?: string;

  @ApiProperty({ description: 'List price in minor units. Never taken from a caller on the public surface.', example: 49000 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  amountCents: number;

  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCIES as unknown as string[], default: 'usd' })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES as unknown as string[])
  currency?: string;

  @ApiPropertyOptional({ enum: INTERVAL_LIST, default: 'monthly' })
  @IsOptional()
  @IsIn(INTERVAL_LIST)
  interval?: string;

  @ApiProperty({
    description: 'Entitlement keys this offer grants once payment is verified. Granted from the event, never from a browser.',
    type: [String],
    example: ['monitoring'],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  entitlements: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateOfferDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerPriceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  amountCents?: number;

  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCIES as unknown as string[] })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES as unknown as string[])
  currency?: string;

  @ApiPropertyOptional({ enum: INTERVAL_LIST })
  @IsOptional()
  @IsIn(INTERVAL_LIST)
  interval?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  entitlements?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListOffersQueryDto {
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Filter on the `active` flag. Omit for both.' })
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: string;

  @ApiPropertyOptional({ description: 'Exact offer code.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;
}

// ── Entitlements / subscriptions / ledger ────────────────────────────────

export class ListEntitlementsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Exact entitlement key, e.g. `monitoring`.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  key?: string;

  @ApiPropertyOptional({ enum: ENTITLEMENT_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(ENTITLEMENT_STATUSES as unknown as string[])
  status?: string;
}

export class RevokeEntitlementDto {
  @ApiProperty({ description: 'Why it is being revoked. Recorded on the audit trail, not on the row.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class ListSubscriptionsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES as unknown as string[])
  status?: string;
}

export class ListPaymentEventsQueryDto {
  @ApiPropertyOptional({ enum: PAYMENT_EVENT_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(PAYMENT_EVENT_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ description: "The provider's own event id — the replay guard." })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerEventId?: string;

  @ApiPropertyOptional({ description: 'Max rows (default 50, cap 200).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ListInvoicesQueryDto {
  @ApiPropertyOptional({ description: 'Scope the ledger to one client.' })
  @IsOptional()
  @IsString()
  clientId?: string;
}

// ── Public checkout status ───────────────────────────────────────────────

export class CheckoutStatusQueryDto {
  @ApiProperty({
    description:
      'The provider checkout session id the returning browser holds. Treated as a bearer capability: it is the only thing authorizing this read.',
  })
  @IsString()
  @Matches(CHECKOUT_SESSION_ID_RE, { message: 'sessionId is not a valid checkout session id' })
  sessionId: string;
}

// ── Public diagnostic request (PB03) ─────────────────────────────────────

export class CreateDiagnosticRequestDto {
  @ApiProperty({ description: 'The site to diagnose. A URL or bare host is normalized to its canonical host.', example: 'example.com' })
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  domain: string;

  @ApiProperty({ description: 'Where the reply goes.', example: 'ops@example.com' })
  @IsEmail()
  @MaxLength(254)
  contactEmail: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @ApiPropertyOptional({ description: "What the requester is trying to achieve — the operator's first question.", maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  goal?: string;

  @ApiProperty({
    description:
      'Must be exactly `true`. Records that the sender agreed to Cailyx contacting them about this request at the address given.',
  })
  @IsBoolean()
  consent: boolean;

  @ApiProperty({ description: 'Token from GET /api/public/diagnostic-challenge. Signed, expiring, single-use.' })
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  challengeToken: string;

  @ApiProperty({
    description: 'The solution to the challenge: any string whose SHA-256 with the token has the required leading zero bits.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  challengeAnswer: string;
}

// ── Public scorecard CTA (PB02) ──────────────────────────────────────────

/** The CTA vocabulary the delivery module's lead ledger already understands. */
export const SCORECARD_CTA_TYPES = ['book-call', 'review-ask', 'upgrade-click'] as const;

export class ScorecardCtaDto {
  @ApiProperty({ enum: SCORECARD_CTA_TYPES as unknown as string[] })
  @IsIn(SCORECARD_CTA_TYPES as unknown as string[])
  type: string;

  @ApiPropertyOptional({ description: 'Supplying an email creates/updates the lead. Requires `consent: true`.' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Required when `email` is supplied.' })
  @IsOptional()
  @IsBoolean()
  consent?: boolean;

  @ApiPropertyOptional({ description: 'Small non-secret context (page, campaign). Capped at 2 KB serialized.', type: Object })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}
