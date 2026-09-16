/**
 * Credential references — how a destination names a secret without holding one.
 *
 * `PublishDestination` stores `credentialRef` (a **name**) and never the
 * credential itself. This file is the whole secret store, and it is honest
 * about being a small one: it resolves a ref against the process environment.
 *
 * ```
 * credentialRef: "acme-wordpress"   ->   PUBLISH_CREDENTIAL_ACME_WORDPRESS
 * ```
 *
 * Naming the env var from the ref (rather than letting the caller pass the var
 * name) keeps the indirection: the value a destination refers to can be rotated
 * without touching the row, and a ref that leaks tells an attacker where to
 * look, not what to use.
 *
 * Two guards matter more than the resolution itself:
 *
 * 1. {@link CREDENTIAL_REF_RE} — a ref must be a short lowercase slug. A
 *    provider key (`sk_live_…`), a JWT, or a base64 blob cannot match it, so the
 *    single place a credential could be persisted on the row is closed by shape,
 *    not by review.
 * 2. {@link resolveCredential} never returns the secret to a caller that is
 *    building a response. It returns a `secret` field that the adapters use and
 *    the view builders ignore — and {@link describeCredential} is what views
 *    call, which yields a boolean.
 *
 * When a dedicated encrypted secret store lands (the Google token store is the
 * precedent: `GOOGLE_TOKEN_ENC_KEY` + `crypto.util`), only this file changes.
 *
 * @module publishing/lib/credentials.util
 */

import { CREDENTIAL_REF_RE } from '../publishing.types';

/** Prefix for every publishing credential env var. */
export const CREDENTIAL_ENV_PREFIX = 'PUBLISH_CREDENTIAL_';

/** The env var name a `credentialRef` resolves against. */
export function credentialEnvVarName(ref: string): string {
  const normalized = ref
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${CREDENTIAL_ENV_PREFIX}${normalized}`;
}

/** True when `ref` is shaped like a name rather than like a credential. */
export function isCredentialRefShaped(ref: string): boolean {
  return CREDENTIAL_REF_RE.test(ref);
}

export interface ResolvedCredential {
  /** Whether a secret was found. */
  configured: boolean;
  /** The secret itself. Adapters use this; views must never serialize it. */
  secret: string | null;
  /** The env var that was consulted — a name, safe to show an operator. */
  envVar: string | null;
  /** Why it is not configured. Null when it is. */
  reason: string | null;
}

/**
 * Resolve a ref against the environment.
 *
 * An unresolvable ref is not an error: it is the `unconfigured` state, and the
 * caller decides whether that blocks the action (a push) or merely annotates it
 * (a read). Nothing here throws, so a read of a destination whose secret was
 * rotated away still returns.
 */
export function resolveCredential(ref: string | null | undefined): ResolvedCredential {
  if (!ref) {
    return { configured: false, secret: null, envVar: null, reason: 'no credential reference is set on this destination' };
  }
  if (!isCredentialRefShaped(ref)) {
    return {
      configured: false,
      secret: null,
      envVar: null,
      reason: `credentialRef "${ref.slice(0, 8)}…" is not a valid reference — it must be a short lowercase slug naming a secret-store entry, not a credential`,
    };
  }

  const envVar = credentialEnvVarName(ref);
  const value = process.env[envVar];
  if (!value || value.trim() === '') {
    return { configured: false, secret: null, envVar, reason: `${envVar} is not set in this environment` };
  }
  return { configured: true, secret: value, envVar, reason: null };
}

/** The view-safe projection: whether it resolves, never what it resolves to. */
export function describeCredential(ref: string | null | undefined): {
  configured: boolean;
  envVar: string | null;
  reason: string | null;
} {
  const resolved = resolveCredential(ref);
  return { configured: resolved.configured, envVar: resolved.envVar, reason: resolved.reason };
}
