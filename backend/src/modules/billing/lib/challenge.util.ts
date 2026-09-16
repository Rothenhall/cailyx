/**
 * The public intake challenge — a server-issued, time-boxed, single-use token
 * plus a proof-of-work the submitter must solve.
 *
 * Why this shape and not a CAPTCHA widget: no third-party verification
 * dependency is approved for this build, and shipping a "captcha" field that
 * nothing verifies would be theatre. This is the real thing, and it is honest
 * about what it is:
 *
 * - **Issued by us.** `GET /api/public/diagnostic-challenge` mints a random
 *   nonce and returns it signed with HMAC-SHA256, together with an expiry and
 *   a difficulty. A caller cannot mint its own challenge — the signature is
 *   checked with `timingSafeEqual`.
 * - **Expires.** The expiry is inside the signed payload, so extending it
 *   requires forging the signature.
 * - **Costs work.** The submitter must find an `answer` whose
 *   `SHA-256(token + ':' + answer)` has at least `difficultyBits` leading zero
 *   bits. At the default 16 bits that is ~65k hashes — imperceptible for a
 *   person filling in a form, and a real per-request cost for a script that
 *   wants to submit thousands.
 * - **Single use.** The nonce is the intake's idempotency key, so redeeming a
 *   token twice returns the first receipt instead of creating a second one.
 *
 * Proof-of-work is not a substitute for the rate limiter or for consent — it
 * is the third layer, and the README says so plainly. It only raises the price
 * of bulk abuse; it does not make an individual abuser impossible.
 *
 * @module billing/lib/challenge.util
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Default proof-of-work difficulty (leading zero bits of the answer hash). */
export const DEFAULT_DIFFICULTY_BITS = 16;
/** How long an issued challenge stays valid. */
export const DEFAULT_CHALLENGE_TTL_SECONDS = 900;
/** Minimum difficulty this service will issue, whatever the env says. */
export const MIN_DIFFICULTY_BITS = 8;
/** Ceiling on difficulty: above this a browser tab visibly stalls. */
export const MAX_DIFFICULTY_BITS = 24;

export const CHALLENGE_ALGORITHM = 'sha256-leading-zero-bits';

/** `v1.<nonce>.<expiresAtSeconds>.<difficultyBits>.<hmacHex>` */
const TOKEN_RE = /^v1\.([0-9a-f]{32})\.(\d{1,12})\.(\d{1,2})\.([0-9a-f]{64})$/;
const ANSWER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface IssuedChallenge {
  token: string;
  nonce: string;
  expiresAt: string;
  difficultyBits: number;
  algorithm: typeof CHALLENGE_ALGORITHM;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time hex comparison (length is not secret: HMACs are 64 chars). */
function hexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Clamp a configured difficulty into the range this service will honour. */
export function clampDifficulty(bits: number | undefined): number {
  if (!Number.isFinite(bits)) return DEFAULT_DIFFICULTY_BITS;
  const value = Math.floor(bits as number);
  if (value < MIN_DIFFICULTY_BITS) return MIN_DIFFICULTY_BITS;
  if (value > MAX_DIFFICULTY_BITS) return MAX_DIFFICULTY_BITS;
  return value;
}

/** Mint a fresh challenge. The nonce is CSPRNG output, never a counter. */
export function issueChallenge(
  secret: string,
  opts: { difficultyBits?: number; ttlSeconds?: number; now?: Date } = {},
): IssuedChallenge {
  const difficultyBits = clampDifficulty(opts.difficultyBits);
  const ttl = opts.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  const nowMs = (opts.now ? opts.now.getTime() : Date.now());
  const expiresAtSeconds = Math.floor(nowMs / 1000) + Math.max(60, Math.floor(ttl));
  const nonce = randomBytes(16).toString('hex');

  const payload = `v1.${nonce}.${expiresAtSeconds}.${difficultyBits}`;
  return {
    token: `${payload}.${sign(secret, payload)}`,
    nonce,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    difficultyBits,
    algorithm: CHALLENGE_ALGORITHM,
  };
}

export type ChallengeRejection = 'malformed' | 'bad-signature' | 'expired';

export type ChallengeVerdict =
  | { valid: true; nonce: string; difficultyBits: number; expiresAt: string }
  | { valid: false; reason: ChallengeRejection };

/**
 * Verify a challenge token: shape, signature, then expiry.
 * The signature is checked before the expiry is trusted, because the expiry is
 * part of the signed payload — an attacker who could edit it would otherwise
 * be able to extend their own window (or expire someone else's).
 */
export function verifyChallengeToken(
  secret: string,
  token: string | undefined,
  now: Date = new Date(),
): ChallengeVerdict {
  if (!token) return { valid: false, reason: 'malformed' };
  const match = TOKEN_RE.exec(token);
  if (!match) return { valid: false, reason: 'malformed' };

  const [, nonce, expiresAtRaw, difficultyRaw, signature] = match;
  const payload = `v1.${nonce}.${expiresAtRaw}.${difficultyRaw}`;
  if (!hexEquals(sign(secret, payload), signature)) return { valid: false, reason: 'bad-signature' };

  const expiresAtSeconds = Number(expiresAtRaw);
  if (Math.floor(now.getTime() / 1000) > expiresAtSeconds) return { valid: false, reason: 'expired' };

  return {
    valid: true,
    nonce,
    difficultyBits: clampDifficulty(Number(difficultyRaw)),
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

/** Leading zero **bits** of a hex digest (not nibbles: `0f` is 4, not 0). */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const char of hex) {
    const nibble = parseInt(char, 16);
    if (Number.isNaN(nibble)) return bits;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    // 1,2,3,4 -> 3 leading zeros; 5..7 -> 2; 9..b -> 1; 8,f -> 0
    bits += nibble < 2 ? 3 : nibble < 4 ? 2 : nibble < 8 ? 1 : 0;
    break;
  }
  return bits;
}

/** The digest a submitter is asked to solve for. */
export function workDigest(token: string, answer: string): string {
  return createHash('sha256').update(`${token}:${answer}`).digest('hex');
}

export type WorkVerdict =
  | { ok: true; answer: string; digest: string; bits: number }
  | { ok: false; reason: 'malformed-answer' | 'insufficient-work'; bits: number };

/**
 * Check the submitted proof of work against the token it was issued for.
 * The token (not just the nonce) is part of the digest, so an answer solved
 * for one challenge cannot be replayed against another.
 */
export function verifyProofOfWork(
  token: string,
  answer: string | undefined,
  requiredBits: number,
): WorkVerdict {
  if (!answer || !ANSWER_RE.test(answer)) return { ok: false, reason: 'malformed-answer', bits: 0 };
  const digest = workDigest(token, answer);
  const bits = leadingZeroBits(digest);
  return bits >= requiredBits
    ? { ok: true, answer, digest, bits }
    : { ok: false, reason: 'insufficient-work', bits };
}
