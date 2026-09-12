/**
 * Presence Discovery — finds the client's accounts on their own site.
 *
 * Social and listing profiles are almost always linked from a site's footer, so
 * this is a shallow crawl by design: the homepage plus a couple of pages whose
 * footers sometimes differ. A deep crawl would cost many times more fetches to
 * find the same links repeated on every page.
 *
 * Two extraction layers, highest trust first (DP2):
 *   1. **JSON-LD `sameAs`** — author-declared and machine-readable.
 *   2. **On-page links** — higher recall, and the reason
 *      {@link classifyUrl} exists: a marketing site's links to `facebook.com`
 *      are more often share widgets than accounts.
 *
 * Verification is best-effort and **honest about failing**. Instagram and
 * Facebook answer a logged-out fetch with a login wall, and LinkedIn answers a
 * datacentre IP with `999`. Those are recorded as `unverified` with the reason,
 * never as `missing` -- see `presence.types`.
 *
 * @module presence.discovery.service
 */

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { FetcherService } from '../fetcher/fetcher.service';
import { classifyUrl, type ClassifiedUrl } from './presence.signatures';
import type { PresenceEntity, PresenceSource, PresenceState } from './presence.types';

/** Pages whose footer is worth a second look when the homepage is thin. */
const FOOTER_PATHS = ['/contact', '/contact-us', '/about', '/about-us'];

/**
 * Hosts that answer a logged-out fetch with a wall rather than the profile.
 * A failed check on these says nothing about whether the account exists, so the
 * reason is phrased as what it is -- a limit of the check, not a fault.
 */
const WALLED: Record<string, string> = {
  instagram: 'Instagram serves a login wall to logged-out requests',
  facebook: 'Facebook serves a login wall to logged-out requests',
  linkedin: 'LinkedIn refuses datacentre IPs (HTTP 999)',
  x: 'X requires authentication to read profiles',
  tiktok: 'TikTok challenges logged-out requests',
  threads: 'Threads requires authentication to read profiles',
};

/** A `sameAs` URL plus whose schema block declared it. */
interface DeclaredLink {
  url: string;
  owner: PresenceEntity;
}

/** One account found during a crawl, before it is stored. */
export interface DiscoveredAccount extends ClassifiedUrl {
  source: PresenceSource;
  foundOn: string;
}

/** Outcome of verifying one URL. */
export interface VerifiedAccount extends DiscoveredAccount {
  state: PresenceState;
  reason: string | null;
  statusCode: number | null;
  title: string | null;
}

@Injectable()
export class PresenceDiscoveryService {
  private readonly logger = new Logger(PresenceDiscoveryService.name);

  constructor(private readonly fetcher: FetcherService) {}

  /**
   * Crawl the client's site and return every account found, deduped.
   *
   * @param domain Bare domain, e.g. `acme.io`.
   * @param runId Correlates the fetches in the fetcher's own logs.
   * @param maxPages Page ceiling (default 4 — footers repeat, deeper costs more
   *   for nothing).
   * @returns Accounts plus the number of pages actually read.
   */
  async crawl(
    domain: string,
    runId: string,
    maxPages = 4,
  ): Promise<{ accounts: DiscoveredAccount[]; pagesFetched: number }> {
    const origin = 'https://' + domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    /** Keyed on the normalised URL so the same profile found twice stays one row. */
    const found = new Map<string, DiscoveredAccount>();
    let pagesFetched = 0;

    const visit = async (url: string): Promise<void> => {
      if (pagesFetched >= maxPages) return;
      try {
        const res = await this.fetcher.fetch({ url, timeout: 20000 }, 'presence-discovery', runId);
        if (res.status < 200 || res.status >= 400 || !res.body) return;
        pagesFetched++;
        for (const acc of this.extract(res.body, url, origin)) {
          // JSON-LD outranks a page link for the same URL: it is declared, not
          // inferred, so it keeps its provenance when both sources see it.
          const existing = found.get(acc.url);
          if (!existing || (existing.source === 'page-link' && acc.source === 'json-ld-sameas')) {
            found.set(acc.url, acc);
          }
        }
      } catch (err) {
        this.logger.debug('Presence fetch skipped ' + url + ': ' + (err as Error).message);
      }
    };

    await visit(origin + '/');
    for (const path of FOOTER_PATHS) {
      if (pagesFetched >= maxPages) break;
      await visit(origin + path);
    }

    return { accounts: [...found.values()], pagesFetched };
  }

  /**
   * Verify each account resolves, mapping every failure to an honest state.
   *
   * @param accounts Accounts from {@link crawl} or operator entry.
   * @param expectedName Brand name, used for a title identity hint.
   * @param runId Fetch correlation id.
   */
  async verify(
    accounts: DiscoveredAccount[],
    expectedName: string | null,
    runId: string,
  ): Promise<VerifiedAccount[]> {
    const out: VerifiedAccount[] = [];

    for (const acc of accounts) {
      // Platforms known to wall logged-out requests are not fetched at all.
      // Spending a request to be told "log in" produces the same answer as not
      // asking, more slowly, and looks like a scraping attempt while doing it.
      const walled = WALLED[acc.platform];
      if (walled) {
        out.push({ ...acc, state: 'unverified', reason: walled, statusCode: null, title: null });
        continue;
      }

      try {
        const res = await this.fetcher.verifyUrl(
          { url: acc.url, expectedName: expectedName ?? undefined },
          'presence-discovery',
          runId,
        );
        out.push({
          ...acc,
          state: res.resolves ? 'confirmed' : 'unverified',
          reason: res.resolves ? null : `The platform answered HTTP ${res.statusCode ?? 'no response'}`,
          statusCode: res.statusCode ?? null,
          title: res.title ?? null,
        });
      } catch (err) {
        out.push({
          ...acc,
          state: 'unverified',
          reason: 'Could not be checked: ' + (err as Error).message,
          statusCode: null,
          title: null,
        });
      }
    }

    return out;
  }

  /**
   * Classify one operator-supplied URL without crawling.
   *
   * @returns `null` when the URL is not a recognised account — the caller turns
   *   that into a 400 naming what was rejected, rather than storing a row the
   *   operator will later see as an unexplained blank.
   */
  classifyOne(url: string): ClassifiedUrl | null {
    return classifyUrl(url);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Both extraction layers over one page.
   *
   * @param ownOrigin The client's own origin — a `sameAs` pointing back at the
   *   site itself is a self-reference, not a profile.
   */
  private extract(html: string, pageUrl: string, ownOrigin: string): DiscoveredAccount[] {
    const out: DiscoveredAccount[] = [];
    const $ = cheerio.load(html);

    // 1. JSON-LD sameAs — declared, highest trust.
    $('script[type="application/ld+json"]').each((_i, el) => {
      const raw = $(el).contents().text();
      if (!raw.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // malformed blocks are common and are not an error here
      }
      for (const { url, owner } of collectSameAs(parsed)) {
        const hit = classifyUrl(url);
        if (hit) {
          // A Person block's sameAs is a person's profile even when the host
          // looks corporate; the platform's own default only applies when the
          // markup did not say.
          const entity = owner !== 'unknown' ? owner : hit.entity;
          out.push({ ...hit, entity, source: 'json-ld-sameas', foundOn: pageUrl });
          continue;
        }
        // No signature matched. For a page LINK that means "not an account" and
        // we drop it. For `sameAs` it means the opposite: the site's own author
        // has asserted "this is us", and there is no ambiguity about ownership
        // to protect against -- only a gap in our signature table. Keeping it as
        // a declared profile is the difference between reporting a client's
        // Google Scholar page and silently losing it.
        const declared = asDeclaredProfile(url, ownOrigin, owner);
        if (declared) out.push({ ...declared, source: 'json-ld-sameas', foundOn: pageUrl });
      }
    });

    // 2. Every anchor on the page, filtered hard by the signature table.
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const abs = absolute(href, pageUrl);
      if (!abs) return;
      const hit = classifyUrl(abs);
      if (hit) out.push({ ...hit, source: 'page-link', foundOn: pageUrl });
    });

    return out;
  }
}

/**
 * Walk arbitrary JSON-LD and collect every `sameAs` value.
 *
 * Handles the three shapes real sites emit: a bare object, an `@graph` array,
 * and `sameAs` as either a string or an array of strings.
 */
function collectSameAs(node: unknown, depth = 0, owner: PresenceEntity = 'unknown'): DeclaredLink[] {
  if (depth > 6 || node === null || typeof node !== 'object') return [];
  const out: DeclaredLink[] = [];

  if (Array.isArray(node)) {
    for (const child of node) out.push(...collectSameAs(child, depth + 1, owner));
    return out;
  }

  const obj = node as Record<string, unknown>;

  // The site tells us who each block is about. `rothenhall.com` declares an
  // Organization whose sameAs is the company LinkedIn, and a Person whose sameAs
  // is a personal LinkedIn plus a Google Scholar page. Carrying that through is
  // the difference between "3 company profiles" and the truth, which is 1.
  const here = ownerOf(obj) ?? owner;

  const same = obj.sameAs;
  if (typeof same === 'string') out.push({ url: same, owner: here });
  else if (Array.isArray(same)) {
    for (const s of same) if (typeof s === 'string') out.push({ url: s, owner: here });
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'sameAs') continue;
    if (value && typeof value === 'object') out.push(...collectSameAs(value, depth + 1, here));
  }

  return out;
}

/** Schema.org types that identify a company, and those that identify a person. */
const ORG_TYPES = /^(Organization|Corporation|LocalBusiness|ProfessionalService|Company|NGO|EducationalOrganization|GovernmentOrganization|Brand|OnlineBusiness|Consortium)$/i;

/** Read `@type` and say whose profile a `sameAs` under it belongs to. */
function ownerOf(obj: Record<string, unknown>): PresenceEntity | null {
  const raw = obj['@type'];
  const types = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  for (const t of types) {
    if (typeof t !== 'string') continue;
    const bare = t.replace(/^https?:\/\/schema\.org\//i, '');
    if (/^Person$/i.test(bare)) return 'personal';
    if (ORG_TYPES.test(bare)) return 'company';
  }
  return null;
}

/**
 * Turn an unrecognised `sameAs` URL into an `other` profile.
 *
 * @returns `null` for a self-reference (the site's own host) or anything that is
 *   not an http(s) URL — neither is a third-party profile.
 */
function asDeclaredProfile(raw: string, ownOrigin: string, owner: PresenceEntity): ClassifiedUrl | null {
  let u: URL;
  let own: URL;
  try {
    u = new URL(raw.trim());
    own = new URL(ownOrigin);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const ownHost = own.hostname.toLowerCase().replace(/^www\./, '');
  if (host === ownHost || host.endsWith(`.${ownHost}`)) return null;

  u.hash = '';
  // The host is the useful label here; the path is whatever that service uses.
  return { platform: 'other', url: u.toString().replace(/\/$/, ''), handle: host, entity: owner };
}

/** Resolve a possibly-relative href against the page it was found on. */
function absolute(href: string, pageUrl: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:') || h.startsWith('javascript:')) {
    return null;
  }
  try {
    return new URL(h, pageUrl).toString();
  } catch {
    return null;
  }
}
