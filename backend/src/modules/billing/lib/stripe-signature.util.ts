/**
 * Stripe webhook signature verification — pure HMAC-SHA256, no SDK.
 *
 * The scheme (Stripe's documented `Stripe-Signature` header):
 *
 * ```
 * Stripe-Signature: t=1614556800,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
 * ```
 *
 * The signed payload is the ASCII string `${t}.${rawBody}` — the timestamp,
 * a literal `.`, then the **exact** request body bytes — and `v1` is
 * `HMAC-SHA256(signingSecret, signedPayload)` hex-encoded. `v0` belongs to the
 * deprecated Stripe Connect scheme and is never accepted here.
 *
 * Two properties this module depends on and this file guarantees:
 *
 * 1. **Exact bytes.** The HMAC is computed over the raw body, never over a
 *    re-serialization of the parsed object. `verifyStripeSignature` takes a
 *    `Buffer` for that reason — see the controller for where it comes from and
 *    what happens when the app cannot supply it.
 * 2. **Constant-time comparison.** Candidate signatures are compared with
 *    `timingSafeEqual`, and every candidate is compared (no early return) so
 *    the number of comparisons does not depend on where a mismatch is.
 *
 * A stale timestamp is rejected so a captured (validly signed) event cannot be
 * replayed later: replay of a *fresh* event is handled instead by the
 * `PaymentEvent.providerEventId` uniqueness in the service.
 *
 * @module billing/lib/stripe-signature.util
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** How far the header timestamp may drift from our clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface ParsedSignatureHeader {
  /** `t=` — Unix seconds. Null when absent or unparseable. */
  timestamp: number | null;
  /** Every `v1=` candidate, lowercased hex. */
  v1: string[];
  /** True when the header looked like a Stripe signature header at all. */
  recognised: boolean;
}

/**
 * Parse a `Stripe-Signature` header. Deliberately lenient about unknown
 * schemes/keys: anything that is not `t` or `v1` is ignored rather than fatal,
 * so a future addition to the header does not break verification.
 */
export function parseSignatureHeader(header: string | undefined): ParsedSignatureHeader {
  const out: ParsedSignatureHeader = { timestamp: null, v1: [], recognised: false };
  if (!header) return out;

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      out.recognised = true;
      const seconds = Number(value);
      out.timestamp = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null;
    } else if (key === 'v1') {
      out.recognised = true;
      if (/^[0-9a-fA-F]{64}$/.test(value)) out.v1.push(value.toLowerCase());
    }
  }
  return out;
}

/** Why a signature was rejected. Never returned verbatim to the provider. */
export type SignatureRejection =
  | 'missing-header'
  | 'malformed-header'
  | 'missing-timestamp'
  | 'timestamp-out-of-tolerance'
  | 'no-v1-candidate'
  | 'no-matching-signature';

export type SignatureVerdict =
  | { valid: true; timestamp: number; scheme: 'v1' }
  | { valid: false; reason: SignatureRejection };

/**
 * The signed payload for a given timestamp and body: `${t}.${body}`, built
 * from the body's bytes so no encoding step can alter them.
 */
export function signedPayload(timestamp: number, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
}

/** `HMAC-SHA256(secret, signedPayload)` as lowercase hex. */
export function computeSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(signedPayload(timestamp, rawBody)).digest('hex');
}

/**
 * Constant-time equality for two hex signatures. A length mismatch is not a
 * secret (hex HMACs are always 64 chars) and short-circuits before
 * `timingSafeEqual`, which throws on unequal lengths.
 */
export function signaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyParams {
  /** The `Stripe-Signature` header, verbatim. */
  header: string | undefined;
  /** The **raw** request body bytes. */
  rawBody: Buffer;
  /** The webhook signing secret (`whsec_...`). */
  secret: string;
  /** Injectable clock, for tests. */
  now?: Date;
  toleranceSeconds?: number;
}

/**
 * Verify one webhook delivery.
 *
 * Order matters: the timestamp tolerance is checked before the HMAC so a
 * week-old captured event is discarded without computing anything, and the
 * HMAC is checked before the caller is allowed to look at the parsed body.
 * Both are attacker-controlled, so neither short-circuit weakens the other.
 */
export function verifyStripeSignature(params: VerifyParams): SignatureVerdict {
  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const parsed = parseSignatureHeader(params.header);

  if (!params.header) return { valid: false, reason: 'missing-header' };
  if (!parsed.recognised) return { valid: false, reason: 'malformed-header' };
  if (parsed.timestamp === null) return { valid: false, reason: 'missing-timestamp' };

  const nowSeconds = Math.floor((params.now ? params.now.getTime() : Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp-out-of-tolerance' };
  }
  if (parsed.v1.length === 0) return { valid: false, reason: 'no-v1-candidate' };

  const expected = computeSignature(params.secret, parsed.timestamp, params.rawBody);
  // Every candidate is compared: returning early on the first match would leak
  // (through timing) how many signatures the header carried.
  let matched = false;
  for (const candidate of parsed.v1) {
    if (signaturesMatch(candidate, expected)) matched = true;
  }

  return matched
    ? { valid: true, timestamp: parsed.timestamp, scheme: 'v1' }
    : { valid: false, reason: 'no-matching-signature' };
}
