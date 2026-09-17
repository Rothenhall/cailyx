/**
 * URL → platform classification.
 *
 * This file exists because of one problem: **most links to a social host on an
 * ordinary marketing site are not accounts.** Share buttons
 * (`facebook.com/sharer/sharer.php?u=…`), intent links
 * (`twitter.com/intent/tweet`), save widgets (`pinterest.com/pin/create/`) and
 * bare hostnames all match a naive `includes('facebook.com')` check, and every
 * one of them would be reported to a client as their Facebook account.
 *
 * So a candidate must clear three gates: host match, reject-pattern miss, and a
 * handle that matches the platform's own shape. Anything that fails is dropped
 * silently -- a false account in a presence report is worse than a missing one,
 * because the operator has no reason to doubt it.
 *
 * @module presence.signatures
 */

import type { PresenceEntity, PresencePlatform } from './presence.types';

interface Signature {
  platform: PresencePlatform;
  /** Hosts that belong to this platform, without `www.`. */
  hosts: string[];
  /**
   * Path shapes that are never an account: share widgets, intent links,
   * help/legal pages, and the platform's own product surface.
   */
  reject: RegExp;
  /**
   * Pulls the handle out of the path. A candidate with no handle is not an
   * account -- a bare `https://instagram.com` link is a logo in a footer.
   */
  handle: RegExp;
  /**
   * True when the platform treats handles case-insensitively. Real sites link
   * the same account both ways -- HubSpot's JSON-LD says `tiktok.com/@HubSpot`
   * while its footer links `@hubspot` -- and without folding, one account is
   * stored and reported as two.
   */
  foldCase?: boolean;
  /**
   * Paths that stay case-sensitive even on a `foldCase` platform. YouTube
   * `@handles` are case-insensitive but `channel/UCxxx` ids are not, and
   * lowercasing one would produce a dead link.
   */
  caseSensitivePath?: RegExp;
  /**
   * Whose profile this is. Omitted means `company` — the default reading for a
   * brand-named handle. LinkedIn needs a function because one host serves both:
   * `/company/acme` is the business, `/in/jane` is a person.
   */
  entity?: PresenceEntity | ((path: string) => PresenceEntity);
}

/**
 * Path segments that are platform furniture on nearly every host: legal pages,
 * help centres, auth screens and the platform's own marketing. Applied on top of
 * each platform's own reject pattern.
 */
const COMMON_REJECT =
  /^\/(share|sharer|intent|login|signup|sign-?in|register|help|support|about|privacy|terms|legal|cookies?|policies|home|explore|search|hashtag|tags?|p|pin|posts?|status|watch|embed|widgets?|plugins?|sharing|dialog|oauth|settings|account|developers?|business|ads?|careers?|jobs|pricing|download|apps?)(\/|$)/i;

const SIGNATURES: Signature[] = [
  {
    platform: 'linkedin',
    foldCase: true,
    // The distinction the whole company-vs-personal split turns on.
    entity: (path) => (/^\/in\//i.test(path) ? 'personal' : 'company'),
    hosts: ['linkedin.com'],
    // /shareArticle and /sharing/share-offsite are the share widgets; /feed and
    // /pulse are content, not the client's profile.
    reject: /^\/(shareArticle|sharing|feed|pulse|jobs|learning|posts)(\/|$)/i,
    handle: /^\/(?:company|school|showcase|in)\/([A-Za-z0-9\-_.%]{2,100})\/?/i,
  },
  {
    platform: 'instagram',
    foldCase: true,
    hosts: ['instagram.com', 'instagr.am'],
    reject: /^\/(p|reel|reels|stories|explore|accounts|direct)(\/|$)/i,
    handle: /^\/([A-Za-z0-9._]{1,30})\/?$/,
  },
  {
    platform: 'facebook',
    foldCase: true,
    hosts: ['facebook.com', 'fb.com', 'fb.me'],
    // sharer.php and dialog/ are the share widgets and by far the most common
    // false positive on a marketing site.
    reject: /^\/(sharer|share|dialog|plugins|tr|events|groups|watch|marketplace|photo|permalink\.php)(\/|\.php|$)/i,
    handle: /^\/(?:pg\/|pages\/[^/]+\/)?([A-Za-z0-9.\-]{2,60})\/?$/,
  },
  {
    platform: 'x',
    foldCase: true,
    hosts: ['twitter.com', 'x.com'],
    reject: /^\/(intent|share|home|search|hashtag|i|explore|messages|compose|notifications)(\/|$)/i,
    handle: /^\/@?([A-Za-z0-9_]{1,15})\/?$/,
  },
  {
    platform: 'youtube',
    foldCase: true,
    caseSensitivePath: /^\/channel\//i,
    hosts: ['youtube.com', 'youtu.be'],
    reject: /^\/(watch|embed|shorts|playlist|results|feed|hashtag)(\/|$)/i,
    // Not end-anchored: a channel is routinely linked as `/@brand/videos` or
    // `/channel/UC…/about`, and anchoring dropped those entirely rather than
    // collapsing them onto the channel root.
    handle: /^\/(?:@|c\/|channel\/|user\/)([A-Za-z0-9\-_.%]{2,100})(?:\/|$)/i,
  },
  {
    platform: 'tiktok',
    foldCase: true,
    hosts: ['tiktok.com'],
    reject: /^\/(video|tag|discover|foryou|upload|music)(\/|$)/i,
    handle: /^\/@([A-Za-z0-9._]{1,30})\/?$/,
  },
  {
    platform: 'pinterest',
    foldCase: true,
    hosts: ['pinterest.com', 'pinterest.co.uk', 'pinterest.ie', 'pin.it'],
    // /pin/create/ is the "Save" widget.
    reject: /^\/(pin|pins|ideas|categories|today|search)(\/|$)/i,
    handle: /^\/([A-Za-z0-9_\-]{3,30})\/?$/,
  },
  {
    platform: 'threads',
    foldCase: true,
    hosts: ['threads.net', 'threads.com'],
    reject: /^\/(t|search|activity)(\/|$)/i,
    handle: /^\/@([A-Za-z0-9._]{1,30})\/?$/,
  },
  {
    platform: 'medium',
    foldCase: true,
    hosts: ['medium.com'],
    reject: /^\/(m|tag|topic|plans|membership)(\/|$)/i,
    handle: /^\/@?([A-Za-z0-9\-_.]{2,60})\/?$/,
  },
  {
    platform: 'substack',
    foldCase: true,
    hosts: ['substack.com'],
    reject: /^\/(home|inbox|browse|discover)(\/|$)/i,
    // Substack publications are subdomains, handled by `subdomainHandle` below.
    handle: /^\/@?([A-Za-z0-9\-_.]{2,60})\/?$/,
  },
  {
    platform: 'github',
    foldCase: true,
    hosts: ['github.com'],
    reject: /^\/(features|pricing|topics|trending|marketplace|sponsors|orgs|settings|login|join|explore)(\/|$)/i,
    handle: /^\/([A-Za-z0-9\-]{1,39})(?:\/[A-Za-z0-9._\-]+)?\/?$/,
  },
  {
    platform: 'crunchbase',
    foldCase: true,
    hosts: ['crunchbase.com'],
    reject: /^\/(discover|search|lists|hub)(\/|$)/i,
    handle: /^\/(?:organization|person)\/([A-Za-z0-9\-_.]{2,80})\/?/i,
  },
  {
    platform: 'g2',
    hosts: ['g2.com'],
    reject: /^\/(categories|compare|search|best-software)(\/|$)/i,
    handle: /^\/products\/([A-Za-z0-9\-_.]{2,80})(?:\/reviews)?\/?/i,
  },
  {
    platform: 'capterra',
    hosts: ['capterra.com', 'capterra.co.uk'],
    reject: /^\/(categories|compare|search)(\/|$)/i,
    handle: /^\/p\/[0-9]+\/([A-Za-z0-9\-_.]{2,80})\/?/i,
  },
  {
    platform: 'trustpilot',
    hosts: ['trustpilot.com'],
    reject: /^\/(categories|search|evaluate|review-collection)(\/|$)/i,
    handle: /^\/review\/([A-Za-z0-9\-_.]{2,120})\/?/i,
  },
  {
    platform: 'glassdoor',
    hosts: ['glassdoor.com', 'glassdoor.co.uk', 'glassdoor.ie'],
    reject: /^\/(Job|Salaries|Interview|Explore|member)(\/|$)/i,
    handle: /^\/(?:Overview|Reviews)\/([A-Za-z0-9\-_.]{2,120})\/?/i,
  },
  {
    platform: 'yelp',
    hosts: ['yelp.com', 'yelp.co.uk', 'yelp.ie'],
    reject: /^\/(search|writeareview|collections|events|c)(\/|$)/i,
    handle: /^\/biz\/([A-Za-z0-9\-_.]{2,120})\/?/i,
  },
  {
    platform: 'producthunt',
    hosts: ['producthunt.com'],
    reject: /^\/(topics|discussions|newsletter|stories|categories)(\/|$)/i,
    handle: /^\/(?:products|posts)\/([A-Za-z0-9\-_.]{2,80})\/?/i,
  },
  {
    platform: 'clutch',
    hosts: ['clutch.co'],
    reject: /^\/(directory|agencies|profile\/add|sitemap)(\/|$)/i,
    handle: /^\/profile\/([A-Za-z0-9\-_.]{2,80})\/?/i,
  },
  {
    platform: 'scholar',
    entity: 'personal',
    hosts: ['scholar.google.com'],
    reject: /^\/(scholar|citations\/?$|intl)(\/|$)/i,
    handle: /[?&]user=([A-Za-z0-9_-]{6,40})/i,
  },
  {
    platform: 'orcid',
    entity: 'personal',
    hosts: ['orcid.org'],
    reject: /^\/(signin|register|about|help)(\/|$)/i,
    handle: /^\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/?/i,
  },
  {
    platform: 'app-store',
    hosts: ['apps.apple.com', 'itunes.apple.com'],
    reject: /^\/(story|charts)(\/|$)/i,
    handle: /\/(?:app|developer)\/(?:[^/]+\/)?(id[0-9]{4,}|[A-Za-z0-9\-_.]{2,80})\/?/i,
  },
  {
    platform: 'play-store',
    hosts: ['play.google.com'],
    reject: /^\/store\/(search|apps\/(top|collection|category))(\/|$)/i,
    handle: /[?&]id=([A-Za-z0-9._]{3,120})/i,
  },
];

/** Hosts whose *subdomain* is the account, not the path. */
const SUBDOMAIN_PLATFORMS: Array<{ platform: PresencePlatform; host: string; reserved: Set<string> }> = [
  {
    platform: 'substack',
    host: 'substack.com',
    reserved: new Set(['www', 'on', 'help', 'support', 'about', 'api', 'blog']),
  },
];

/** A classified candidate, before it becomes a row. */
export interface ClassifiedUrl {
  platform: PresencePlatform;
  /** Normalised — scheme and host lowercased, tracking params dropped. */
  url: string;
  handle: string;
  /** Company or a person. Personal rows stay out of the company footprint. */
  entity: PresenceEntity;
}

/** Query params that are tracking noise, never part of a profile's identity. */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_|ref|source|igshid|si|feature)/i;

/**
 * Classify one URL.
 *
 * @param raw The href as it appeared in the markup.
 * @returns The platform, normalised URL and handle, or `null` when the URL is
 *   not an account — a share widget, a bare hostname, or an unknown host.
 */
export function classifyUrl(raw: string): ClassifiedUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname || '/';

  // Subdomain-as-account hosts are checked first: `brand.substack.com` has an
  // empty path and would otherwise fail every handle shape.
  for (const s of SUBDOMAIN_PLATFORMS) {
    if (host.endsWith(`.${s.host}`)) {
      const sub = host.slice(0, -(s.host.length + 1));
      if (!sub || sub.includes('.') || s.reserved.has(sub)) return null;
      return { platform: s.platform, url: normalize(u), handle: sub, entity: 'company' };
    }
  }

  const sig = SIGNATURES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  if (!sig) return null;

  // Collapse locale and mobile subdomains onto the canonical host. Google
  // returns `linkedin.com/company/acme`, `do.linkedin.com/company/acme` and
  // `ar.linkedin.com/company/acme` as three results for one account -- a client
  // report listing their LinkedIn three times reads as broken software.
  // Subdomain-as-account hosts (Substack) returned earlier and never reach here.
  const baseHost = sig.hosts.find((h) => host === h || host.endsWith(`.${h}`));
  if (baseHost && host !== baseHost) u.hostname = baseHost;

  if (COMMON_REJECT.test(path) || sig.reject.test(path)) return null;

  // play-store carries the id in the query string, so match against the whole
  // URL rather than just the path.
  const target = sig.platform === 'play-store' ? `${u.pathname}${u.search}` : path;
  const m = sig.handle.exec(target);
  if (!m || !m[1]) return null;

  // Canonicalise to the profile root. A SERP returns `/company/acme`,
  // `/company/acme/life`, `/company/acme/jobs` and `/company/acme/about` as four
  // results; they are one account, and without this each becomes its own row
  // because the unique key is the URL. Only safe when the pattern matched from
  // the start of the path (so nothing before it is discarded) and the handle is
  // not carried in the query string.
  if (sig.platform !== 'play-store' && sig.platform !== 'scholar' && m.index === 0) {
    u.pathname = m[0].replace(/\/$/, '') || '/';
    // Query strings on a profile URL are tracking or locale noise
    // (`?originalSubdomain=in`), never identity — and they split the key.
    u.search = '';
  }

  let handle = decodeURIComponent(m[1]).replace(/\/$/, '');
  if (!handle || handle.length < 1) return null;

  // Fold case where the platform does, so the same account linked two ways
  // dedupes to one row rather than being reported twice.
  const fold = sig.foldCase === true && !(sig.caseSensitivePath?.test(path) ?? false);
  if (fold) {
    handle = handle.toLowerCase();
    u.pathname = u.pathname.toLowerCase();
  }

  const entity: PresenceEntity =
    typeof sig.entity === 'function' ? sig.entity(path) : (sig.entity ?? 'company');

  return { platform: sig.platform, url: normalize(u), handle, entity };
}

/**
 * Strip tracking params, fragments and trailing slashes so re-runs dedupe —
 * exported so callers outside this module (the rejection tombstone) key on
 * exactly the same normalized form as account dedupe does, rather than
 * maintaining a second, driftable copy of this logic.
 */
export function normalizeUrl(raw: string): string {
  try {
    return normalize(new URL(raw));
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalize(u: URL): string {
  const out = new URL(u.toString());
  out.hash = '';
  out.hostname = out.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...out.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) out.searchParams.delete(key);
  }
  let s = out.toString();
  // Keep a meaningful query (play-store's ?id=) but drop an empty one.
  s = s.replace(/\?$/, '');
  if (out.pathname !== '/' ) s = s.replace(/\/(\?|$)/, '$1');
  return s;
}
