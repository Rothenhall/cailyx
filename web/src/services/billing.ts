import { api } from '@/lib/api';

/**
 * Public billing/intake adapter — PB03 (request a diagnostic) and PB04
 * (checkout return). Both routes are unauthenticated and live under
 * `/api/public`, so nothing here may assume a session.
 *
 * Mirrors `backend/src/modules/billing/billing-public.controller.ts`,
 * `diagnostic-intake.service.ts` and `lib/challenge.util.ts`.
 *
 * The one rule this file exists to keep: **a checkout return grants nothing.**
 * `getCheckoutStatus` reports what the signature-verified provider ledger says
 * — `pending` means no signed event has arrived yet, which is neither a failure
 * nor a purchase, and `purchaseVerified` is true only for `verified`. No value
 * this adapter can return is a decision to give anyone access to anything.
 */

// ── PB03 — the abuse-protected public intake ────────────────────────────

/** The challenge a submitter must solve before their request is accepted. */
export interface DiagnosticChallenge {
  /** `v1.<nonce>.<expiresAtSeconds>.<difficultyBits>.<hmacHex>`. */
  token: string;
  nonce: string;
  expiresAt: string;
  /** Leading zero bits the answer's SHA-256 must have. */
  difficultyBits: number;
  algorithm: string;
  ttlSeconds: number;
  /** Plain-language statement of what is being asked of the submitter. */
  statement: string;
}

export interface DiagnosticRequestInput {
  domain: string;
  contactEmail: string;
  contactName?: string;
  company?: string;
  /** What the requester is trying to achieve — the operator's first question. */
  goal?: string;
  /** Must be exactly `true`; the record exists because the sender agreed. */
  consent: true;
  challengeToken: string;
  challengeAnswer: string;
}

/** The submission receipt. */
export interface DiagnosticReceipt {
  receiptId: string;
  projectId: string;
  leadId: string;
  /** Null when no run was created (one of this kind was already queued). */
  jobRunId: string | null;
  status: 'queued' | 'received';
  domain: string;
  contactEmail: string;
  submittedAt: string;
  /** What happens next, and what does not. */
  nextStep: string;
  /** Why the run did not hand itself to a worker. Null when it did. */
  runNotStartedReason: string | null;
  duplicate: boolean;
}

/** The consent sentence the server records, versioned by its own text. */
export const CONSENT_STATEMENT =
  'I agree that Cailyx may contact me about this request at the email address I supplied.';

/**
 * Mint a challenge. Throws a 503 `unavailable` when no challenge secret is
 * configured, which closes the intake — an unverifiable challenge would be
 * worse than a closed door because it looks like protection.
 */
export async function getDiagnosticChallenge(options?: {
  signal?: AbortSignal;
}): Promise<DiagnosticChallenge> {
  return api.get<DiagnosticChallenge>('/public/diagnostic-challenge', options);
}

/**
 * Submit the request.
 *
 * A 400 means the challenge was unsolved or the token was not one this server
 * issued, or `consent` was not true; a 429 is either the IP throttle or the
 * per-domain cap (three per 24 h). Both are named conditions with their own
 * recovery, not generic failures.
 */
export async function submitDiagnosticRequest(
  input: DiagnosticRequestInput,
): Promise<DiagnosticReceipt> {
  return api.post<DiagnosticReceipt>('/public/diagnostic-request', input);
}

// ── The browser side of the proof of work ───────────────────────────────

/**
 * Leading zero **bits** of a hex digest — not nibbles.
 *
 * This is a faithful port of `leadingZeroBits` in the backend's
 * `challenge.util.ts`; the two must agree exactly, or a solved challenge is
 * rejected as unsolved. `0f` counts 4, `1x` counts 3, `2x`–`3x` count 2,
 * `4x`–`7x` count 1, `8x`/`9x`–`fx` count 0.
 */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const char of hex) {
    const nibble = Number.parseInt(char, 16);
    if (Number.isNaN(nibble)) return bits;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += nibble < 2 ? 3 : nibble < 4 ? 2 : nibble < 8 ? 1 : 0;
    break;
  }
  return bits;
}

/** `sha256(token + ':' + answer)`, hex — the digest the challenge asks for. */
async function workDigest(token: string, answer: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${token}:${answer}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** How many candidate answers are hashed concurrently. */
const WORK_BATCH = 64;

/**
 * Find an answer whose digest meets the challenge's difficulty.
 *
 * Runs in the browser and yields between batches, so the form stays responsive
 * and the progress readout is real: at the default 16 bits this is ~65k hashes,
 * imperceptible for one person and a real per-request price for a script.
 *
 * The answer alphabet is digits, which the server's `ANSWER_RE`
 * (`[A-Za-z0-9._-]{1,64}`) accepts. `onProgress` reports hashes tried — it is
 * a count of work actually done, never an estimate of work remaining.
 *
 * Throws if the caller aborts. There is no timeout of its own: a
 * higher-difficulty challenge legitimately takes longer, and silently giving up
 * would report a solved challenge as unsolvable.
 */
export async function solveChallenge(
  token: string,
  difficultyBits: number,
  options?: { signal?: AbortSignal; onProgress?: (tried: number) => void },
): Promise<string> {
  // `crypto.subtle` only exists in a secure context. Saying so is better than
  // letting a TypeError surface as an unexplained failure on a form whose
  // submit button simply never completes.
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'This browser will not run the challenge: the Web Crypto API is unavailable outside a secure (https) context. Open this page over https, or ask for a diagnostic by email instead.',
    );
  }

  let counter = 0;
  for (;;) {
    if (options?.signal?.aborted) {
      throw new DOMException('Challenge solving was cancelled.', 'AbortError');
    }

    const candidates: string[] = [];
    for (let i = 0; i < WORK_BATCH; i += 1) candidates.push(String(counter + i));
    counter += WORK_BATCH;

    const digests = await Promise.all(candidates.map((answer) => workDigest(token, answer)));

    for (let i = 0; i < digests.length; i += 1) {
      if (leadingZeroBits(digests[i]) >= difficultyBits) {
        options?.onProgress?.(counter);
        return candidates[i];
      }
    }

    options?.onProgress?.(counter);
  }
}

// ── PB04 — the checkout return ──────────────────────────────────────────

export interface CheckoutStatus {
  sessionId: string;
  /**
   * `verified` — a signature-verified event for this session was processed.
   * `pending` — nothing confirmed yet: either no event has arrived
   * (`onRecord: false`) or one is still being processed. **Not a failure, and
   * not a grant.** `rejected` — an event failed signature verification.
   * `ignored` — verified but deliberately not acted on.
   */
  status: 'verified' | 'pending' | 'rejected' | 'ignored';
  /** True only for `verified`. A page visit can never set it. */
  purchaseVerified: boolean;
  onRecord: boolean;
  /** The server-side offer resolved from the event, when one matched. */
  offer: {
    code: string;
    name: string;
    amountCents: number;
    currency: string;
    interval: string;
  } | null;
  entitlements: Array<{ key: string; status: string }>;
  /** Why nothing has been granted, or why an event was not acted on. */
  reason: string | null;
  eventType: string | null;
  receivedAt: string | null;
  /** What the returning customer should do next, in plain words. */
  nextAction: string;
}

/**
 * Was this checkout session actually paid for?
 *
 * `sessionId` is a bearer capability from the provider's redirect — it is what
 * authorizes the read, and it is why this route can be public. A malformed id
 * is a 404.
 */
export async function getCheckoutStatus(
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<CheckoutStatus> {
  return api.get<CheckoutStatus>('/public/checkout/status', { ...options, query: { sessionId } });
}

// ── Billing capability ──────────────────────────────────────────────────

export interface BillingCapability {
  webhook: { configured: boolean; secretEnvVar: string; reason: string | null };
  /** Where checkout links are issued from today (operator-side, pre-G16). */
  checkout: { configured: boolean; reason: string };
  /** True when the raw request body is available for exact-byte HMAC. */
  rawBodyCapture: { enabled: boolean; reason: string | null };
  publicIntake: { configured: boolean; reason: string | null; challengeDifficultyBits: number };
}

/**
 * What billing can and cannot do right now.
 *
 * Operator-authenticated (`GET /billing/capability`) and names the missing
 * environment variable rather than a value, so an unconfigured checkout can be
 * reported as unconfigured instead of as an empty list.
 */
export async function getBillingCapability(options?: {
  signal?: AbortSignal;
}): Promise<BillingCapability> {
  return api.get<BillingCapability>('/billing/capability', options);
}
