/**
 * Delivery Controller — REST surface for PRD §6.11 (email, leads + CTA log,
 * Stripe Checkout upgrades).
 *
 * @module delivery.controller
 */

import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, Roles } from '../../common/decorators/auth.decorators';
import { DeliveryService } from './delivery.service';
import { CreateLeadDto, LogCtaDto, SendReportDto, UpdateLeadDto } from './dto/delivery.dto';
import { CreateUpgradeDto, UpdateUpgradeDto } from './dto/upgrade.dto';

@ApiTags('Delivery')
@Throttle({ default: { ttl: 60000, limit: 60 } })
@Controller('projects/:projectId/delivery')
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  // ─── Email (FR-11.1) ───────────────────────────────────────────────

  @Post('send')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Send the delivery email (Plunk)',
    description: 'Report link + booking CTA (+ optional testimonial ask). 503 email-unconfigured without PLUNK_SECRET_KEY; sender identity comes from PLUNK_SENDER_EMAIL.',
  })
  @ApiResponse({ status: 200, description: 'Delivered' })
  send(@Param('projectId') projectId: string, @Body() body: SendReportDto) {
    return this.delivery.sendReport(projectId, body);
  }

  // ─── Leads (FR-11.2 / FR-11.3) ─────────────────────────────────────

  @Post('leads')
  @ApiOperation({ summary: 'Capture a lead', description: 'Sources: bulk | api | form | scorecard (scorecard leads carry scorecardRunId).' })
  createLead(@Param('projectId') projectId: string, @Body() body: CreateLeadDto) {
    return this.delivery.createLead(projectId, body);
  }

  @Get('leads')
  @ApiOperation({ summary: 'List leads (newest first, optional ?status=)' })
  listLeads(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.delivery.listLeads(projectId, status);
  }

  @Get('leads/export')
  @Header('Content-Type', 'text/csv')
  @ApiOperation({ summary: 'CSV export of the lead pipeline (for any external CRM)' })
  exportCsv(@Param('projectId') projectId: string) {
    return this.delivery.exportLeadsCsv(projectId);
  }

  @Get('leads/:leadId')
  @ApiOperation({ summary: 'One lead with its full CTA event log' })
  getLead(@Param('projectId') projectId: string, @Param('leadId') leadId: string) {
    return this.delivery.getLead(projectId, leadId);
  }

  @Patch('leads/:leadId')
  @ApiOperation({ summary: 'Update lead pipeline status (new → reached → booked → won | lost)' })
  updateLead(@Param('projectId') projectId: string, @Param('leadId') leadId: string, @Body() body: UpdateLeadDto) {
    return this.delivery.updateLead(projectId, leadId, body);
  }

  @Post('leads/:leadId/cta')
  @ApiOperation({ summary: 'Log a CTA click (book-call | review-ask | upgrade-click)', description: 'Appended to the lead event log — never overwritten (FR-11.3).' })
  logCta(@Param('projectId') projectId: string, @Param('leadId') leadId: string, @Body() body: LogCtaDto) {
    return this.delivery.logCta(projectId, leadId, body);
  }

  // ─── Upgrades (FR-11.4) ────────────────────────────────────────────

  @Post('upgrades')
  @ApiOperation({ summary: 'Issue a Stripe Checkout link for a tier', description: 'URLs come from STRIPE_CHECKOUT_URL_FULL / STRIPE_CHECKOUT_URL_MONITORING; 503 payment-unconfigured when absent.' })
  createUpgrade(@Param('projectId') projectId: string, @Body() body: CreateUpgradeDto) {
    return this.delivery.createUpgrade(projectId, body);
  }

  @Get('upgrades')
  @ApiOperation({ summary: 'List upgrade ledger rows (newest first)' })
  listUpgrades(@Param('projectId') projectId: string) {
    return this.delivery.listUpgrades(projectId);
  }

  @Post('upgrades/:upgradeId/click')
  @ApiOperation({ summary: 'Log the checkout click (flips ledger + lead event log)' })
  click(@Param('projectId') projectId: string, @Param('upgradeId') upgradeId: string) {
    return this.delivery.markClicked(projectId, upgradeId);
  }

  /**
   * Marks an upgrade completed **by hand**.
   *
   * This used to be `@Public()`, standing in for the Stripe webhook before the
   * billing module existed. That is no longer acceptable: G16 now provides the
   * real signed webhook path (`POST /api/billing/webhooks/stripe`), so an
   * unauthenticated endpoint that flips a payment ledger row is a straight
   * forgery hole — anyone who could reach the API could mark an upgrade paid.
   *
   * The guard is the fix for that, not a permanent design. This route remains
   * for assisted sales, where an operator has confirmed the payment out of band
   * and needs to record it. It is admin-only because it writes a money-adjacent
   * ledger, and it still records no entitlement — entitlement comes from a
   * verified provider event and nothing else (G16 rule 4).
   */
  @Roles('admin')
  @Post('upgrades/:upgradeId/complete')
  @ApiOperation({
    summary: 'Record an upgrade as completed (admin, assisted sales only)',
    description:
      'Operator-recorded completion for assisted sales. Unauthenticated completion was removed: payments are confirmed by the signed Stripe webhook at /api/billing/webhooks/stripe, which is the only path that grants an entitlement.',
  })
  @ApiResponse({ status: 200, description: 'The updated ledger row' })
  @ApiResponse({ status: 401, description: 'Not authenticated — this endpoint is no longer public' })
  @ApiResponse({ status: 403, description: 'Caller is not an admin' })
  complete(@Param('projectId') projectId: string, @Param('upgradeId') upgradeId: string, @Body() body: UpdateUpgradeDto) {
    return this.delivery.markCompleted(projectId, upgradeId, body.stripeSessionId);
  }
}