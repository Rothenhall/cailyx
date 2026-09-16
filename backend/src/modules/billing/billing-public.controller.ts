/**
 * The unauthenticated, browser-facing surface of G16.
 *
 * Everything here is reachable by anyone with the URL, so each route either
 * takes a bearer capability the caller must already hold (a checkout session
 * id, a scorecard's public token), or answers with nothing that is not already
 * public (an issued challenge). None of them writes an entitlement, and none of
 * them reads a caller-supplied paid status.
 *
 * Two classes in one file because they are one surface — the checkout-return
 * read and the public intake — kept together so the whole unauthenticated
 * footprint of this package is countable in one place. Both mount under
 * `/api/public`, matching the existing public attribution route.
 *
 * @module billing-public.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/auth.decorators';
import { BillingService } from './billing.service';
import { DiagnosticIntakeService } from './diagnostic-intake.service';
import { CheckoutStatusQueryDto, CreateDiagnosticRequestDto, ScorecardCtaDto } from './dto/billing.dto';

/**
 * The checkout-return read (PB04).
 *
 * `sessionId` is a bearer capability: it comes from the URL the provider
 * redirected to, and it is the only thing that authorizes the read. That is
 * safe because the provider's session ids are unguessable — and because of what
 * this route *cannot* do: it never grants, never writes, and reports a webhook
 * that has not arrived yet as `pending` rather than as a failure or a success.
 */
@ApiTags('billing: public checkout')
@Controller('public')
export class PublicCheckoutController {
  constructor(private readonly service: BillingService) {}

  @Public()
  @Get('checkout/status')
  @Throttle({ default: { ttl: 60_000, limit: 15 } })
  @ApiOperation({
    summary: 'Was this checkout session actually paid for?',
    description:
      'Answered from the signature-verified provider event ledger and nothing else — a visit to the return page proves nothing, so this read grants nothing. ' +
      '`pending` means no signed event has arrived yet (not a failure, not a purchase); `verified` means a verified event was processed and the entitlements are listed.',
  })
  @ApiResponse({ status: 200, description: 'CheckoutStatusView' })
  @ApiResponse({ status: 404, description: 'The session id is not a well-formed checkout session id' })
  async status(@Query() query: CheckoutStatusQueryDto) {
    return this.service.getCheckoutStatus(query.sessionId);
  }
}

/**
 * The public intake: the diagnostic request (PB03) and the scorecard CTA
 * capture (PB02).
 *
 * Both are throttled per IP *and* gated by the per-domain cap in the service,
 * because a botnet defeats an IP limit and a single domain is the thing an
 * abuser actually wants. Neither trusts an amount, a price or a paid status.
 */
@ApiTags('billing: public intake')
@Controller('public')
export class PublicIntakeController {
  constructor(private readonly intake: DiagnosticIntakeService) {}

  @Public()
  @Get('diagnostic-challenge')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: 'Issue a challenge for the public diagnostic request',
    description:
      'Returns a signed, expiring token and the proof-of-work difficulty the submitter must satisfy. No third-party CAPTCHA is used: the challenge is issued and verified by this server with HMAC-SHA256 (constant-time) and a SHA-256 proof of work, and the nonce is single-use. 503 when no challenge secret is configured.',
  })
  @ApiResponse({ status: 200, description: '{ token, nonce, expiresAt, difficultyBits, algorithm, statement }' })
  @ApiResponse({ status: 503, description: 'No challenge secret configured — the intake is closed' })
  async challenge() {
    return this.intake.issueChallengeForCaller();
  }

  @Public()
  @Post('diagnostic-request')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'Request a diagnostic (public, abuse-protected)',
    description:
      'Requires a solved challenge and `consent: true`. Creates an unenriched project stub, a lead carrying the contact, and a queued job-run receipt for an operator. ' +
      'The expensive site enrichment stays operator-side, behind the JWT — nothing here fetches the submitted domain.',
  })
  @ApiBody({ type: CreateDiagnosticRequestDto })
  @ApiResponse({ status: 201, description: 'DiagnosticReceiptView — receipt id, project id, job-run id' })
  @ApiResponse({ status: 400, description: 'Missing consent, an unsolved challenge, or an invalid domain' })
  @ApiResponse({ status: 429, description: 'Rate limited, or the domain has hit its daily cap' })
  @ApiResponse({ status: 503, description: 'The intake is not configured' })
  async request(@Body() dto: CreateDiagnosticRequestDto) {
    return this.intake.submit(dto);
  }

  @Public()
  @Post('scorecard/:publicToken/cta')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: 'publicToken', description: "The scorecard's public share token — the only credential a shared-scorecard visitor holds." })
  @ApiOperation({
    summary: 'Capture a CTA from a shared scorecard (public)',
    description:
      'The public counterpart of the operator CTA routes: a visitor on a shared scorecard has no session, so the token in the URL scopes the write to that scorecard\'s project. ' +
      'Gated by the same SCORECARD_PUBLIC flag as the public scorecard read. Supplying an email requires consent.',
  })
  @ApiBody({ type: ScorecardCtaDto })
  @ApiResponse({ status: 201, description: '{ leadId, projectId, leadCreated, ctaEvents, nextStep }' })
  @ApiResponse({ status: 400, description: 'Unknown token, missing consent for a supplied email, or oversized meta' })
  @ApiResponse({ status: 403, description: 'Public scorecards are disabled' })
  async scorecardCta(@Param('publicToken') publicToken: string, @Body() dto: ScorecardCtaDto) {
    return this.intake.captureScorecardCta(publicToken, dto);
  }
}
