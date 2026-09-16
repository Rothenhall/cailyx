/**
 * BillingPortalController — G16's client surface (CP15, CP13).
 *
 * `@ClientPortal()` marks the whole class, so RolesGuard's default-deny
 * applies: an operator hitting these routes is rejected, and a client can
 * reach nothing that is not marked this way. `clientId` comes from the JWT and
 * never from a request field — there is no `?clientId=` here on purpose, so a
 * client cannot ask for another client's entitlements by editing a URL.
 *
 * Everything is read-only. A client cannot buy, cancel or revoke from here:
 * purchases happen at the provider, and a cancellation is either driven by a
 * signed provider event or performed by an operator. Letting the portal change
 * its own entitlement state would create a second way to grant access.
 *
 * @module billing-portal.controller
 */

import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { BillingService } from './billing.service';

@ApiTags('billing: client portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/billing')
export class BillingPortalController {
  constructor(private readonly service: BillingService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: 'This client\'s subscriptions', description: 'Includes a canceled subscription — a client who cancelled should still see what they had.' })
  @ApiResponse({ status: 200, description: '{ subscriptions: SubscriptionView[] }' })
  async subscriptions(@CurrentUser() user: AuthedRequestUser) {
    return { subscriptions: await this.service.subscriptionsForClient(this.requireClientId(user)) };
  }

  @Get('entitlements')
  @ApiOperation({
    summary: 'What this client is allowed to use',
    description: 'Active, expired and revoked rows are all returned — a revoked entitlement is a fact the client is entitled to see, not something to hide.',
  })
  @ApiResponse({ status: 200, description: '{ entitlements: EntitlementView[] }' })
  async entitlements(@CurrentUser() user: AuthedRequestUser) {
    return { entitlements: await this.service.entitlementsForClient(this.requireClientId(user)) };
  }

  @Get('invoices')
  @ApiOperation({
    summary: 'Payment history, from the verified event ledger',
    description: 'Carries the same `providerInvoices.configured: false` disclosure as the operator route: these are Cailyx\'s verified payment events, not provider-issued invoice documents.',
  })
  @ApiResponse({ status: 200, description: '{ invoices, providerInvoices }' })
  async invoices(@CurrentUser() user: AuthedRequestUser) {
    return this.service.listInvoices(this.requireClientId(user));
  }

  @Get('customer-portal')
  @ApiOperation({
    summary: 'Billing-portal state for this client',
    description:
      'Reports whether a hosted provider portal is available and, when it is not, why — rather than returning a URL that does not work. Creating a provider portal session needs a provider API client, which this build does not have; the summary below is served from Cailyx\'s own ledger.',
  })
  @ApiResponse({ status: 200, description: '{ available, reason, subscription, entitlements }' })
  async customerPortal(@CurrentUser() user: AuthedRequestUser) {
    const clientId = this.requireClientId(user);
    const [subscriptions, entitlements] = await Promise.all([
      this.service.subscriptionsForClient(clientId),
      this.service.entitlementsForClient(clientId),
    ]);

    return {
      available: false,
      reason:
        'A hosted billing portal session requires a provider API client, which is not configured in this build. To change or cancel a plan, contact Cailyx — the change is recorded against your account either way.',
      /** The most recent subscription, which is the one a portal would manage. */
      subscription: subscriptions[0] ?? null,
      entitlements,
    };
  }

  /**
   * Structurally guaranteed by RolesGuard: only a `type="client"` user with a
   * clientId reaches a `@ClientPortal()` route. Re-checked here rather than
   * trusted from two layers away, matching the delivery-plan portal controller.
   */
  private requireClientId(user: AuthedRequestUser): string {
    if (!user.clientId) {
      throw new Error(
        'Client-portal route reached by a user with no clientId — this is a guard bug, not a client error.',
      );
    }
    return user.clientId;
  }
}
