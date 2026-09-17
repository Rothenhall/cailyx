/**
 * Page identity normalization (P12, §7.4).
 *
 * Turns a raw URL (a GSC `page` key, a GA `landingPage` value, or a
 * technical-audit crawled URL) into one canonical identity string that the
 * three sources can be joined through — without discarding the original.
 *
 * Rules (§7.4, deliberately conservative):
 *  - host is lowercased (DNS is case-insensitive); the path is NOT — a site
 *    that actually uses case-sensitive paths must not have them collapsed.
 *  - a single trailing slash is normalized away (except the root `/`), since
 *    that is host-server behavior, not a distinct page, on virtually every
 *    stack Cailyx clients run.
 *  - only params in the configured tracking-param set are stripped. Any
 *    other query param is treated as potentially functional (language
 *    variant, pagination, A/B slot) and kept — so distinct pages stay
 *    distinct.
 *  - language-path and market-path segments (e.g. `/en/`, `/de/`) are part
 *    of `path` and are never collapsed — they are different pages by design.
 */

export interface NormalizedPage {
  /** `host + path + sorted-kept-query` — the join key. */
  canonicalUrl: string;
  host: string;
  path: string;
  /** The exact input this was derived from, preserved verbatim. */
  raw: string;
}

/** Default tracking params known to identify visits, not distinct pages. */
export const DEFAULT_TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
]);

export function normalizePageUrl(raw: string, trackingParams: Set<string> = DEFAULT_TRACKING_PARAMS): NormalizedPage {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // GSC/GA sometimes report a bare path ("/pricing") rather than an
    // absolute URL. Anchor it to a placeholder host purely to parse it —
    // the placeholder is never used as `host` below when a real one exists
    // in the caller's project context; callers pass the project's own host
    // as fallback via `withHost` when needed.
    try {
      u = new URL(raw, 'https://unresolved.invalid');
    } catch {
      return { canonicalUrl: raw, host: '', path: raw, raw };
    }
  }
  const host = u.hostname.toLowerCase();
  let path = u.pathname; // case preserved deliberately
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (!path) path = '/';

  const kept: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (!trackingParams.has(k.toLowerCase())) kept.push(`${k}=${v}`);
  }
  kept.sort();
  const query = kept.length ? `?${kept.join('&')}` : '';

  return { canonicalUrl: `${host}${path}${query}`, host, path, raw };
}

/** Re-resolve a host-less normalization (bare path from a Google report) against the project's known host. */
export function withHost(n: NormalizedPage, knownHost: string): NormalizedPage {
  if (n.host && n.host !== 'unresolved.invalid') return n;
  const host = knownHost.toLowerCase();
  return { ...n, host, canonicalUrl: `${host}${n.canonicalUrl.replace(/^unresolved\.invalid/, '')}` };
}
