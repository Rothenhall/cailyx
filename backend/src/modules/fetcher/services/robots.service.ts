/**
 * Robots.txt compliance — decides whether OUR OWN crawlers are allowed to
 * fetch a given URL, per the site's own robots.txt.
 *
 * `technical-audit.service.ts` already fetches and parses robots.txt, but
 * only to REPORT whether AI bots are blocked (PRD §6.2) — it never uses the
 * result to constrain what this codebase's own multi-page crawlers do.
 * `page-inventory.check.ts` (sitemap crawl), `aeo-context.service.ts` (site-
 * context crawl) and `presence.discovery.service.ts` (footer sweep) each
 * decide what to fetch on their own terms and none of them consult robots.txt
 * at all. This service is the missing piece: a shared, per-origin-cached
 * parser + matcher any crawler can consult before adding a URL to its queue.
 *
 * Deterministic, in-repo, no new dependency — same discipline as `tech-stack`
 * (decision D3) — over data `FetcherService` already retrieves.
 *
 * @module robots.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { FetcherService } from '../fetcher.service';

/** One `User-agent:` group: the agent tokens it applies to, and its rules. */
interface RobotsGroup {
  /** Lowercased product tokens, e.g. ['*'] or ['googlebot', 'googlebot-image']. */
  userAgents: string[];
  allow: string[];
  disallow: string[];
}

interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  fetchedAt: number;
}

/** Matches `technical-audit.service.ts`'s own robots.txt cache TTL. */
const CACHE_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class RobotsService {
  private readonly logger = new Logger(RobotsService.name);
  /** Keyed on origin (`https://example.com`) — one robots.txt per host, not per path. */
  private readonly cache = new Map<string, ParsedRobots>();

  constructor(private readonly fetcher: FetcherService) {}

  /**
   * Is `url` allowed to be fetched, per the site's robots.txt?
   *
   * Fails OPEN (returns `true`) whenever robots.txt cannot be fetched or
   * parsed. A crawl budget spent on a page we should not have visited is a
   * smaller problem than the alternative: treating "we could not check" as
   * "everything is blocked" would silently stop a crawler on a transient
   * network error, which is a worse failure mode than the one this service
   * exists to prevent.
   *
   * @param userAgent Product token to match against robots.txt groups.
   *   Defaults to `'*'` because this codebase's own crawlers present a plain
   *   browser User-Agent (`BROWSER_CONTROL`, `fetcher.constants.ts`), not an
   *   identified bot — so the rules that actually govern them are whichever
   *   group covers everyone, exactly like a real browser visitor.
   */
  async isAllowed(url: string, userAgent = '*', runId?: string): Promise<boolean> {
    let origin: string;
    let path: string;
    try {
      const u = new URL(url);
      origin = u.origin;
      path = u.pathname + u.search;
    } catch {
      return true; // not a fetchable URL at all — let the fetch itself fail honestly
    }

    const robots = await this.getRobots(origin, runId);
    if (!robots) return true;

    const group = selectGroup(robots.groups, userAgent);
    return pathAllowed(group, path);
  }

  /**
   * Filter a candidate URL list down to the ones robots.txt allows, in order.
   * The shape every crawler actually wants: build the candidate list your own
   * way, then narrow it by this one call before fetching any of them.
   */
  async filterAllowed(urls: string[], userAgent = '*', runId?: string): Promise<string[]> {
    if (urls.length === 0) return [];
    // One robots.txt fetch serves every URL on the same origin — resolve it
    // once rather than re-deriving it per candidate.
    const out: string[] = [];
    for (const url of urls) {
      if (await this.isAllowed(url, userAgent, runId)) out.push(url);
    }
    return out;
  }

  /** Sitemap URLs the site's own robots.txt declares, if any. */
  async declaredSitemaps(origin: string, runId?: string): Promise<string[]> {
    const robots = await this.getRobots(this.originOf(origin), runId);
    return robots?.sitemaps ?? [];
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private originOf(originOrUrl: string): string {
    try {
      return new URL(originOrUrl).origin;
    } catch {
      return originOrUrl.replace(/\/+$/, '');
    }
  }

  /** Fetch + parse robots.txt for one origin, cached in-process for {@link CACHE_TTL_MS}. */
  private async getRobots(origin: string, runId?: string): Promise<ParsedRobots | null> {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

    try {
      const res = await this.fetcher.fetch(
        { url: origin + '/robots.txt', cacheTtlSeconds: 86400 },
        'robots-service',
        runId,
      );
      // A missing or erroring robots.txt declares no restrictions — the same
      // honest reading `technical-audit.service.ts`'s own robots check uses
      // (`missingRobotsTxt` there is a *finding*, not a block).
      if (res.status === 0 || res.status >= 400 || !res.body) {
        const empty: ParsedRobots = { groups: [], sitemaps: [], fetchedAt: Date.now() };
        this.cache.set(origin, empty);
        return empty;
      }
      const { groups, sitemaps } = parseRobotsTxt(res.body);
      const parsed: ParsedRobots = { groups, sitemaps, fetchedAt: Date.now() };
      this.cache.set(origin, parsed);
      return parsed;
    } catch (err) {
      this.logger.debug(`robots.txt fetch failed for ${origin}: ${(err as Error).message}`);
      return null; // caller treats null as "could not check" and fails open
    }
  }
}

/**
 * Parse robots.txt text into groups.
 *
 * One or more consecutive `User-agent:` lines share the rules that follow —
 * real robots.txt files lean on this heavily ("User-agent: a\nUser-agent:
 * b\nDisallow: /admin" applies `/admin` to both a and b). A `User-agent:`
 * line seen AFTER a rule has already started a new group, per the spec every
 * major crawler implements.
 */
function parseRobotsTxt(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!value) break;
        if (!collectingAgents || !current) {
          current = { userAgents: [], allow: [], disallow: [] };
          groups.push(current);
          collectingAgents = true;
        }
        current.userAgents.push(value.toLowerCase());
        break;
      }
      case 'disallow':
        if (current) current.disallow.push(value);
        collectingAgents = false;
        break;
      case 'allow':
        if (current) current.allow.push(value);
        collectingAgents = false;
        break;
      case 'sitemap':
        if (value) sitemaps.push(value);
        break;
      default:
        // crawl-delay, host, request-rate, etc. — not needed for allow/disallow
        // matching, but seeing one still ends the current agent-collecting run.
        collectingAgents = false;
        break;
    }
  }

  return { groups, sitemaps };
}

/**
 * Pick the group that governs `userAgent`.
 *
 * Per the de-facto standard every major crawler follows: the group whose
 * product token is the LONGEST case-insensitive substring match of
 * `userAgent` wins (more specific beats less specific); `*` is the fallback
 * used only when nothing more specific matched.
 */
function selectGroup(groups: RobotsGroup[], userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLen = -1;

  for (const g of groups) {
    for (const token of g.userAgents) {
      if (token === '*') {
        if (bestLen < 0) {
          best = g;
          bestLen = 0;
        }
        continue;
      }
      if (ua.includes(token) && token.length > bestLen) {
        best = g;
        bestLen = token.length;
      }
    }
  }
  return best;
}

/**
 * Is `path` allowed under `group`? Longest-matching-pattern wins between
 * Allow and Disallow (Allow breaking a tie), the same precedence rule every
 * major crawler applies — a more specific rule overrides a broader one
 * regardless of which directive it is or where it appears in the file.
 */
function pathAllowed(group: RobotsGroup | null, path: string): boolean {
  if (!group) return true; // no group at all governs this agent — nothing restricts it

  let matchedLen = -1;
  let allowed = true;

  const consider = (patterns: string[], isAllow: boolean) => {
    for (const pattern of patterns) {
      if (!pattern) continue; // an empty Disallow/Allow value matches nothing
      const len = matchLength(pattern, path);
      if (len === null) continue;
      // >= so that when Allow and Disallow tie on specificity, Allow — added
      // second below — wins, matching the documented tie-break.
      if (len >= matchedLen) {
        matchedLen = len;
        allowed = isAllow;
      }
    }
  };

  consider(group.disallow, false);
  consider(group.allow, true);

  return allowed;
}

/**
 * Match one robots.txt pattern against a path, returning the matched
 * pattern's length (for longest-match precedence) or `null` when it does not
 * match. Supports the two characters the spec gives special meaning: `*`
 * (wildcard, any run of characters) and a trailing `$` (end-anchor).
 */
function matchLength(pattern: string, path: string): number | null {
  const endAnchored = pattern.endsWith('$');
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = '^' + escaped + (endAnchored ? '$' : '');
  try {
    return new RegExp(re).test(path) ? pattern.length : null;
  } catch {
    return null; // a malformed pattern matches nothing rather than throwing
  }
}
