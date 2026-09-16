/**
 * Domain normalization and validation — G04.
 *
 * Why this file exists: design_plan.md §5.3 says "Creating a client project
 * fails on an existing domain" and G04 adds "Domain correction requires
 * validated normalization/conflict/ownership policy, not changing a display
 * label." `Project.domain` is `@unique` on the raw string, so
 * `https://Example.com/`, `www.example.com` and `example.com` are three
 * different values as far as the database is concerned — three projects for
 * one business, which is the duplicate §5.3 is about.
 *
 * Everything that compares, writes or reasons about a project domain goes
 * through {@link normalizeDomain} first, so "the same domain" means the same
 * thing everywhere in this module. It is a validation helper, not a
 * beautifier: it throws rather than guessing when the input is not a host.
 *
 * @module lib/domain.util
 */

import { BadRequestException } from '@nestjs/common';

/**
 * Hostname rule: one or more dot-separated labels, each 1-63 characters of
 * `[a-z0-9-]` that does not start or end with a hyphen, with an alphabetic
 * final label (a TLD). The alphabetic-TLD requirement is what rejects a bare
 * IPv4 literal — `192.168.0.1` is not a domain a client can own, and treating
 * it as one would let it collide with a real hostname rule.
 */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `http://` / `https://` — the only schemes we strip rather than reject. */
const STRIPPABLE_SCHEME_RE = /^https?:\/\//i;
/** Any scheme with an authority, e.g. `ftp://`, `ws://`. Rejected, not coerced. */
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize a user- or extractor-supplied domain to its bare registrable host:
 * lowercase, no scheme, no `www.`, no credentials, no port, no path/query/
 * fragment, no trailing dot.
 *
 * Every transformation is a pure presentation difference — nothing here
 * changes which host the string denotes, so a caller can show `before`/`after`
 * side by side and a reviewer can see the normalization was not a guess.
 * Anything that is NOT a presentation difference (an unsupported scheme, an
 * email address, an IP literal, a bare word) is rejected rather than coerced.
 *
 * @param input raw value as typed in a wizard, read from a scrape, or stored
 *   on a legacy `Project.domain`.
 * @returns the bare lowercase host, e.g. `example.com`.
 * @throws BadRequestException the input is empty, is not a hostname, or
 *   carries a scheme we will not silently reinterpret.
 */
export function normalizeDomain(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) throw new BadRequestException('domain is required');

  if (ANY_SCHEME_RE.test(raw) && !STRIPPABLE_SCHEME_RE.test(raw)) {
    throw new BadRequestException(
      `domain "${input}" carries an unsupported scheme — only http:// and https:// are stripped`,
    );
  }

  let host = raw;
  const hadScheme = STRIPPABLE_SCHEME_RE.test(raw);
  if (hadScheme) {
    host = raw.replace(STRIPPABLE_SCHEME_RE, '');
    // Userinfo (`user:pass@host`) is only meaningful inside an authority, so
    // it is only stripped when a scheme established one. Without a scheme an
    // `@` means the caller typed something that is not a domain (an email
    // address, most likely) and the hostname rule below rejects it — better
    // than silently answering with a different string than they gave.
    const at = host.lastIndexOf('@');
    if (at !== -1) host = host.slice(at + 1);
  }

  // Drop path, query and fragment — `example.com/pricing` denotes the host
  // `example.com`, which is exactly what a domain correction should store.
  host = host.split(/[/?#]/)[0] ?? '';

  // Drop a port (guarding the bracketed IPv6 form, which the hostname rule
  // rejects anyway but must not be mangled into a false pass).
  if (!host.startsWith('[')) {
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }

  host = host.trim().toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('www.')) host = host.slice(4);

  if (!HOSTNAME_RE.test(host)) {
    throw new BadRequestException(
      `domain "${input}" is not a valid hostname — expected something like "example.com"`,
    );
  }
  return host;
}

/**
 * Non-throwing form of {@link normalizeDomain}, for read paths that must show
 * what is stored (including a legacy value that is not a valid host) rather
 * than fail on it.
 * @returns the normalized host, or `null` when the value cannot be normalized.
 */
export function tryNormalizeDomain(input: string | null | undefined): string | null {
  try {
    return normalizeDomain(input ?? '');
  } catch {
    return null;
  }
}
