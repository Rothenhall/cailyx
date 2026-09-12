/**
 * Page-signal extraction — everything `seo-rubric.ts` needs, pulled from
 * server HTML with cheerio.
 *
 * This lived as a private method on `PageInventoryCheck` until the competitors
 * module needed the same signals for a rival's homepage. Copying it would have
 * meant two rubrics drifting apart: a client scored 62 and a competitor scored
 * 71 by *different* rules is a comparison that looks quantitative and is not.
 * One exported pure function, one rubric, both sides scored identically.
 *
 * Server HTML only, deliberately — the same limit `page-inventory` documents.
 * Nothing here renders JS, so a fully client-rendered page honestly reports
 * near-zero content rather than a guess.
 *
 * @module technical-audit/checks/page-signals
 */

import * as cheerio from 'cheerio';
import { contentFingerprint, type PageSignals } from './seo-rubric';

/** Signals plus the two extras only some callers need. */
export type ExtractedPageSignals = PageSignals & {
  jsonLdTypes: string[];
  contentHash: string | null;
};

/**
 * Walk a parsed JSON-LD value for every `@type` it declares, including the
 * nesting containers that routinely hide the real entity (`@graph` especially).
 * Depth-capped: a malformed or self-referential document must not spin.
 */
export function collectJsonLdTypes(node: unknown, depth = 0): string[] {
  if (depth > 6 || node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((n) => collectJsonLdTypes(n, depth + 1));

  const obj = node as Record<string, unknown>;
  const out: string[] = [];
  const t = obj['@type'];
  if (typeof t === 'string') out.push(t);
  else if (Array.isArray(t)) out.push(...t.filter((x): x is string => typeof x === 'string'));

  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'hasPart']) {
    if (obj[key]) out.push(...collectJsonLdTypes(obj[key], depth + 1));
  }
  return out;
}

/** Everything the rubric needs, pulled from server HTML with cheerio. */
export function extractPageSignals(
  html: string,
  status: number,
  url: string,
  siteHost: string,
): ExtractedPageSignals {
  const $ = cheerio.load(html);

  const title = $('head title').first().text().trim() || $('title').first().text().trim() || null;
  const metaDescription =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    null;
  const canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;

  const robots = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase();
  const noindex = robots.includes('noindex');

  // Document order, every h1-h6 — the heading-hierarchy check needs the full
  // sequence, not just the h1 count.
  const headingLevels: number[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = parseInt((el as { tagName: string }).tagName.substring(1), 10);
    if (Number.isFinite(level)) headingLevels.push(level);
  });

  // Strip the parts of the document that are not prose before counting, or
  // an inline script bundle reads as thousands of words of content.
  const body = $('body').clone();
  body.find('script, style, noscript, template, svg').remove();
  const text = body.text().replace(/\s+/g, ' ').trim();
  const wordCount = text ? text.split(' ').length : 0;
  const contentHash = contentFingerprint(text);

  // Content images only. An image the author marked decorative -- alt="",
  // aria-hidden, or role="presentation" -- is correctly described as needing
  // no description, so counting it as a fault would tell a client to "fix"
  // markup that is already right. Tracking pixels (1x1) go the same way.
  let imageCount = 0;
  let imagesMissingAlt = 0;
  $('img').each((_, el) => {
    const $img = $(el);
    const alt = $img.attr('alt');
    const decorative =
      alt === '' ||
      $img.attr('aria-hidden') === 'true' ||
      $img.attr('role') === 'presentation' ||
      ($img.attr('width') === '1' && $img.attr('height') === '1');
    if (decorative) return;
    imageCount++;
    // `undefined` means the attribute is absent entirely -- the actual fault.
    if (alt === undefined) imagesMissingAlt++;
  });

  const jsonLdTypes: string[] = [];
  let jsonLdCount = 0;
  let jsonLdValid = true;
  $('script[type="application/ld+json"]').each((_, el) => {
    jsonLdCount++;
    const raw = $(el).contents().text().trim();
    if (!raw) {
      jsonLdValid = false;
      return;
    }
    try {
      jsonLdTypes.push(...collectJsonLdTypes(JSON.parse(raw)));
    } catch {
      jsonLdValid = false;
    }
  });
  if (jsonLdCount === 0) jsonLdValid = false;

  return {
    status,
    title,
    metaDescription,
    h1Count: $('h1').length,
    canonical,
    wordCount,
    imageCount,
    imagesMissingAlt,
    contentHash,
    jsonLdCount,
    jsonLdValid,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    noindex,
    url,
    siteHost,
    headingLevels,
  };
}
