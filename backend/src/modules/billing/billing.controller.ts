/**
 * BillingController — G16's operator surface.
 *
 * Reads and price administration only. There is deliberately **no** endpoint
 * here that grants an entitlement, marks a payment received, or records a
 * subscription: the only writer of those is the signature-verified webhook
 * (`StripeWebhookService`), which is reachable without a session but cannot be
 * satisfied without the signing secret. A "mark this paid" route — even
 * admin-only — would be a second way to grant access, and the acceptance test
 * for this package is precisely that there is not one.
 *
 * Audience split, by what the data actually exposes:
 *
 * - **Offers** — any operator may read them (the UI shows prices); only an
 *   admin may write, because an offer is the price mapping.
 * - **Entitlements / subscriptions / invoices** — admin and delivery-lead:
 *   what a client is allowed to use is a commercial fact.
 * - **The event ledger** — admin only. A row's raw payload carries the
 *   customer's name, email and billing address, so the list route returns the
 *   payload's *shape* and the single-event route is the only one that returns
 *   the payload itself.
 *
 * @module billing.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { BillingService, WEBHOOK_SECRET_ENV } from './billing.service';
import { StripeWebhookService } from './stripe-webhook.service';
import {
  CreateOfferDto,
  ListEntitlementsQueryDto,
  ListInvoicesQueryDto,
  ListOffersQueryDto,
  ListPaymentEventsQueryDto,
  ListSubscriptionsQueryDto,
  RevokeEntitlementDto,
  UpdateOfferDto,
} from './dto/billing.dto';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(
    private readonly service: BillingService,
    private readonly webhooks: StripeWebhookService,
  ) {}

  @Get('capability')
  @ApiOperation({
    summary: 'What billing can and cannot do right now',
    description:
      `Explicit configured/unconfigured state for the verified webhook (${WEBHOOK_SECRET_ENV}), checkout links and the public intake — with the env var name that is missing, never a value. A screen renders this instead of an empty list.`,
  })
  @ApiResponse({ status: 200, description: 'BillingCapabilityView' })
  async capability() {
    // Reported from what the last delivery actually used, not asserted about
    // main.ts — the app-level raw-body setting is not readable from a module.
    return this.service.capability(this.webhooks.lastBodyIntegrity);
  }

  // ── Offers ──────────────────────────────────────────────────────────

  @Get('offers')
  @ApiOperation({
    summary: 'Offers (the server-side price mapping)',
    description: 'Any operator may read prices. Filter with `?active=true|false` or `?code=`.',
  })
  @ApiResponse({ status: 200, description: '{ offers: OfferView[] }' })
  async listOffers(@Query() query: ListOffersQueryDto) {
    return this.service.listOffers({ active: query.active, code: query.code });
  }

  @Get('offers/:code')
  @ApiOperation({ summary: 'One offer by its code' })
  @ApiResponse({ status: 404, description: 'No offer with that code' })
  async getOffer(@Param('code') code: string) {
    return this.service.getOfferByCode(code);
  }

  @Post('offers')
  @Roles('admin')
  @ApiOperation({
    summary: 'Create an offer (admin)',
    description:
      'Defines what a checkout is worth: the amount, the currency, the provider price id and the entitlement keys it grants. This row is the authority the webhook reads — never the payload it came in on.',
  })
  @ApiBody({ type: CreateOfferDto })
  @ApiResponse({ status: 201, description: 'The created offer' })
  @ApiResponse({ status: 409, description: 'The code is already taken' })
  async createOffer(@CurrentUser() user: AuthedRequestUser, @Body() dto: CreateOfferDto) {
    return this.service.createOffer(dto, user.userId);
  }

  @Patch('offers/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Edit an offer (admin)', description: 'Deactivating (`active: false`) is the supported removal — grants already made are unaffected.' })
  @ApiBody({ type: UpdateOfferDto })
  @ApiResponse({ status: 200, description: 'The updated offer' })
  @ApiResponse({ status: 404, description: 'No offer with that id' })
  async updateOffer(
    @CurrentUser() user: AuthedRequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateOfferDto,
  ) {
    return this.service.updateOffer(id, dto, user.userId);
  }

  // ── Entitlements ────────────────────────────────────────────────────

  @Get('entitlements')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Entitlements, filterable by client/key/status',
    description: 'Each row names the verified payment event that authorized it (`grantedByEventId`) — an entitlement with no such event predates G16 and is flagged by that null.',
  })
  @ApiResponse({ status: 200, description: '{ entitlements: EntitlementView[] }' })
  async listEntitlements(@Query() query: ListEntitlementsQueryDto) {
    return this.service.listEntitlements(query);
  }

  @Post('entitlements/:id/revoke')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke an entitlement (admin)',
    description:
      'The operator action for a refund or a contract decision. Provider-driven cancellation revokes through the webhook instead; this route exists because a partial refund is not a cancellation and someone has to decide.',
  })
  @ApiBody({ type: RevokeEntitlementDto })
  @ApiResponse({ status: 200, description: 'The revoked entitlement' })
  @ApiResponse({ status: 404, description: 'No such entitlement' })
  @ApiResponse({ status: 409, description: 'Already revoked' })
  async revokeEntitlement(
    @CurrentUser() user: AuthedRequestUser,
    @Param('id') id: string,
    @Body() dto: RevokeEntitlementDto,
  ) {
    return this.service.revokeEntitlement(id, dto.reason, user.userId);
  }

  // ── Subscriptions ───────────────────────────────────────────────────

  @Get('subscriptions')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Subscriptions, filterable by client/status' })
  @ApiResponse({ status: 200, description: '{ subscriptions: SubscriptionView[] }' })
  async listSubscriptions(@Query() query: ListSubscriptionsQueryDto) {
    return this.service.listSubscriptions(query);
  }

  @Get('subscriptions/:id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'One subscription' })
  @ApiResponse({ status: 404, description: 'No such subscription' })
  async getSubscription(@Param('id') id: string) {
    return this.service.getSubscription(id);
  }

  // ── Payment event ledger ────────────────────────────────────────────

  @Get('events')
  @Roles('admin')
  @ApiOperation({
    summary: 'The payment-event ledger (admin)',
    description:
      'Newest first, filterable by status/client/providerEventId. The raw payload is **not** returned here — it holds the customer\'s name, email and address. `payloadKeys` summarises its shape instead; use the single-event route for the payload itself.',
  })
  @ApiResponse({ status: 200, description: '{ events: PaymentEventView[] }' })
  async listEvents(@Query() query: ListPaymentEventsQueryDto) {
    return this.service.listPaymentEvents(query);
  }

  @Get('events/:id')
  @Roles('admin')
  @ApiOperation({
    summary: 'One payment event **with its raw payload** (admin)',
    description: 'Includes the provider payload verbatim, which is why this route is admin-only rather than operator-wide.',
  })
  @ApiResponse({ status: 200, description: 'PaymentEventDetailView' })
  @ApiResponse({ status: 404, description: 'No such event' })
  async getEvent(@Param('id') id: string) {
    return this.service.getPaymentEvent(id);
  }

  // ── Invoices ────────────────────────────────────────────────────────

  @Get('invoices')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Invoice-shaped lines from the verified event ledger',
    description:
      'Cailyx has no provider invoice API in this build, so these are the payment events it has confirmed by signature. The envelope carries `providerInvoices.configured: false` with the reason, so a screen cannot present a ledger line as a provider-issued invoice.',
  })
  @ApiResponse({ status: 200, description: '{ invoices: LedgerInvoiceView[], providerInvoices: { configured, reason } }' })
  async listInvoices(@Query() query: ListInvoicesQueryDto) {
    return this.service.listInvoices(query.clientId);
  }
}
