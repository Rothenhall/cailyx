/**
 * StripeWebhookController — `POST /api/billing/webhooks/stripe`.
 *
 * The only unauthenticated **write** in the system, which is why it has no
 * `@Body()` DTO at all:
 *
 * - A DTO with the global `ValidationPipe`'s `whitelist`/`forbidNonWhitelisted`
 *   would strip or reject the provider's own fields. The body is read as bytes
 *   and parsed here instead, and the *signature* — not a validator — is what
 *   decides whether it is trustworthy.
 * - The response status is set explicitly, because the provider's retry
 *   behaviour depends on it: 2xx means "handled, do not retry", 400 means
 *   "this delivery is not acceptable" (a bad signature — retrying will not fix
 *   it), 500 means "retry me" (processing failed after verification), and 503
 *   means "this server is not configured to verify anything yet".
 *
 * `@Throttle` is set generously (600/min) rather than tightly: the limit keys
 * on IP, the provider delivers from a small set of shared addresses, and a
 * throttle that drops real purchases to stop an attacker who cannot pass the
 * signature check anyway would be a self-inflicted outage. Verification is one
 * HMAC per request; the abuse cost is already near zero without a limit.
 *
 * @module billing-webhooks.controller
 */

import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/auth.decorators';
import { StripeWebhookService } from './stripe-webhook.service';

@ApiTags('billing: webhooks')
@Controller('billing/webhooks')
export class StripeWebhookController {
  constructor(private readonly webhooks: StripeWebhookService) {}

  @Public()
  @Post('stripe')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  @ApiOperation({
    summary: 'Signed provider webhook (unauthenticated)',
    description:
      'Verifies the HMAC-SHA256 `Stripe-Signature` against the configured signing secret (constant-time, with a timestamp tolerance), then acts on the event. ' +
      'An unsigned, mismatched or stale delivery is stored with `signatureValid: false`, `status: "rejected"` and is never acted on. A replayed event id is handled idempotently and grants nothing a second time. ' +
      '503 when no signing secret is configured: nothing is trusted, and nothing is stored.',
  })
  @ApiResponse({ status: 200, description: 'Handled (or a duplicate of an already-handled event)' })
  @ApiResponse({ status: 400, description: 'Signature did not verify, or the event carries no id — recorded as rejected' })
  @ApiResponse({ status: 500, description: 'Verified but processing failed; the row stays pending and a retry resumes it' })
  @ApiResponse({ status: 503, description: 'No signing secret configured — nothing was read or stored' })
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const outcome = await this.webhooks.handle({
      // Present only when the application captures raw bodies (`rawBody: true`
      // in main.ts). See the module README for what happens when it is not.
      rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody : null,
      parsedBody: req.body,
      signatureHeader: this.headerValue(req.headers['stripe-signature']),
    });

    res.status(outcome.httpStatus);
    return outcome.body;
  }

  /** `Stripe-Signature` is a single header, but Express types it as an array. */
  private headerValue(raw: string | string[] | undefined): string | undefined {
    if (Array.isArray(raw)) return raw[0];
    return raw;
  }
}
