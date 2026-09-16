/**
 * Domain normalization and admission for the public intake.
 *
 * The intake accepts a domain from an unauthenticated caller and turns it into
 * a `Project` candidate, so the value is normalized to one canonical form
 * before it is compared (the `Project.domain` column is unique, and
 * `https://WWW.Example.com/path` and `example.com` are the same site — treating
 * them as two projects would split a client's history in half).
 *
 * Admission also rejects hosts the intake has no business *fetching* later:
 * IP literals, `localhost`, and single-label hosts. The expensive enrichment
 * runs server-side against this value, so letting `127.0.0.1` or
 * `metadata.internal` through would turn a public form into a probe of the
 * host's own network.
 *
 * @module billing/lib/domain.util
 */

import { BadRequestException } from '@nestjs/common';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Suffixes that are never a public site — internal, container, mDNS names. */
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa', '.test', '.invalid', '.example'];

/**
 * Normalize a user-supplied domain (or URL) to its canonical host, or throw.
 *
 * `https://WWW.Example.com:443/blog?x=1` -> `example.com`.
 *
 * @throws BadRequestException the value is empty, is not a public hostname, or
 *   is an IP literal / internal name.
 */
export function normalizeDomain(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new BadRequestException('domain is required');
  }

  let value = input.trim().toLowerCase();
  value = value.replace(SCHEME_RE, '');
  // Drop credentials, path, query and fragment. A '@' before the first '/' is
  // userinfo; anything after it there is not part of the host.
  const slash = value.search(/[/?#]/);
  const authority = slash === -1 ? value : value.slice(0, slash);
  const at = authority.lastIndexOf('@');
  value = at === -1 ? authority : authority.slice(at + 1);
  // An IPv6 literal cannot be a project domain; strip a port if that is all
  // the colon is doing, otherwise refuse.
  if (value.includes('[') || value.includes(']')) {
    throw new BadRequestException('domain must be a public hostname, not an IP address');
  }
  if (value.includes(':')) {
    if (!/:\d{1,5}$/.test(value)) {
      throw new BadRequestException('domain must be a public hostname, not an IP address');
    }
    value = value.replace(/:\d{1,5}$/, '');
  }
  value = value.replace(/\.$/, '');

  if (value === '') throw new BadRequestException('domain is required');
  if (IPV4_RE.test(value)) throw new BadRequestException('domain must be a public hostname, not an IP address');
  if (value === 'localhost' || !value.includes('.')) {
    throw new BadRequestException('domain must include a public top-level domain (e.g. example.com)');
  }
  if (INTERNAL_SUFFIXES.some((suffix) => value.endsWith(suffix))) {
    throw new BadRequestException('domain must be a public site, not an internal host name');
  }
  if (!HOSTNAME_RE.test(value)) {
    throw new BadRequestException('domain is not a valid hostname');
  }
  return value;
}
