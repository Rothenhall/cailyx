/**
 * SERP analyzer — pure function turning a normalized provider response into the
 * per-query metrics we persist (subject rank, AI-Overview presence, competitor
 * presence, source spread).
 *
 * @module serp-intelligence.serp-analyzer
 */

import { hostOf, scoreAnswerForSubject } from '../../common/utils/subject-match';
import { titleIdentifies } from '../entity-audit/entity-audit.consistency';
import { inferBusinessProfile, type BusinessProfile } from '../digital-presence/presence.types';
import type { LocalPackEntry, SerpItem, SerpResponse } from './serp-intelligence.types';

export interface AnalyzedSerp {
  subjectRank: number | null;
  subjectUrl: string | null;
  aiOverviewPresent: boolean;
  aiOverviewMentionsSubject: boolean;
  featuredSnippetDomain: string | null;
  topDomains: Array<{ domain: string; rank: number }>;
  competitorsSeen: string[];
  sourceCount: number;
  rawItemCount: number;
}

export function analyzeSerp(
  resp: SerpResponse,
  subject: { name: string; domain: string },
  competitors: Array<{ name: string; domain: string | null }>,
): AnalyzedSerp {
  const subjectHost = (subject.domain || '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .toLowerCase();

  const organic = resp.items
    .filter((i) => i.type === 'organic' && typeof i.rankAbsolute === 'number' && i.domain)
    .sort((a, b) => (a.rankAbsolute as number) - (b.rankAbsolute as number));

  // subject best organic rank
  let subjectRank: number | null = null;
  let subjectUrl: string | null = null;
  for (const it of organic) {
    if (subjectHost && (it.domain || '').toLowerCase().endsWith(subjectHost)) {
      subjectRank = it.rankAbsolute as number;
      subjectUrl = it.url ?? null;
      break;
    }
  }

  const aiItem = resp.items.find((i) => i.type === 'ai_overview');
  const aiOverviewPresent = !!aiItem;
  let aiOverviewMentionsSubject = false;
  if (aiItem) {
    const m = scoreAnswerForSubject(aiItem.text ?? '', aiItem.references ?? [], subject, []);
    aiOverviewMentionsSubject = m.mentioned || m.cited;
  }

  const featuredSnippetDomain =
    resp.items.find((i) => i.type === 'featured_snippet')?.domain ?? null;

  const topDomains = dedupeByDomain(
    organic.slice(0, 10).map((i) => ({ domain: (i.domain as string).toLowerCase(), rank: i.rankAbsolute as number })),
  );

  // competitor presence — by domain among any item, or by name in titles / AI text
  const haystackText = resp.items
    .map((i) => `${i.title ?? ''} ${i.text ?? ''}`)
    .join(' ')
    .toLowerCase();
  const allDomains = new Set(
    resp.items
      .flatMap((i) => [i.domain ?? '', ...(i.references ?? []).map(hostOf)])
      .filter(Boolean)
      .map((d) => d.toLowerCase()),
  );
  const competitorsSeen = competitors
    .filter((c) => {
      const byDomain =
        c.domain &&
        [...allDomains].some((d) => d.endsWith(c.domain!.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()));
      const byName = c.name.length > 2 && haystackText.includes(c.name.toLowerCase());
      return byDomain || byName;
    })
    .map((c) => c.name);

  const sourceCount = new Set(
    [
      ...resp.items.map((i) => (i.domain ?? '').toLowerCase()),
      ...resp.items.flatMap((i) => (i.references ?? []).map(hostOf)),
    ].filter(Boolean),
  ).size;

  return {
    subjectRank,
    subjectUrl,
    aiOverviewPresent,
    aiOverviewMentionsSubject,
    featuredSnippetDomain,
    topDomains,
    competitorsSeen: [...new Set(competitorsSeen)],
    sourceCount,
    rawItemCount: resp.items.length,
  };
}

// ─── Local pack (Maps/local results) ───────────────────────────────────────

export interface LocalPackResult {
  /**
   * Whether "are you in the local pack" is even a meaningful question for
   * this business — gated on the client's inferred business type so a global
   * B2B SaaS company never gets a false "missing from Maps" finding the same
   * way `digital-presence`'s `EXPECTED_BY_PROFILE` never asks a B2B
   * consultancy to have a TikTok. Local-intent SERPs are common for almost
   * ANY query when the searcher's own location is nearby, so gating on the
   * BUSINESS rather than on whether Google happened to show a pack is what
   * keeps this from becoming noise for everyone.
   */
  applicable: boolean;
  /** Printed alongside `applicable` so the gate is never a silent guess. */
  reason: string;
  /** Null when not applicable, or when no local pack appeared for this query at all. */
  present: boolean | null;
  /** 1-based rank within the pack, when present. */
  rank: number | null;
  /** Every business the pack actually showed, win or lose — for context. */
  entries: LocalPackEntry[];
}

/**
 * Local Maps/pack visibility for one SERP — gated to businesses the client's
 * own category text marks as local-services, reusing `digital-presence`'s
 * business-type inference so the two modules cannot disagree about what
 * counts as "a local business" (same reuse discipline as `titleIdentifies`
 * below — wave-6 step 5's rule against growing a second, subtly different copy).
 *
 * @param items The SERP's normalised items — a `local_pack` entry may or may
 *   not be among them; Google only shows one for local-intent queries.
 * @param brand The client's own name, matched against each pack entry's
 *   `title` with the same loose containment rule a fetched platform title
 *   is judged by everywhere else in this codebase.
 * @param category The client's own category text — the same input
 *   `inferBusinessProfile` already takes in `digital-presence`.
 */
export function analyzeLocalPack(
  items: SerpItem[],
  brand: string | null,
  category: string | null | undefined,
): LocalPackResult {
  const businessProfile: BusinessProfile = inferBusinessProfile(category);
  if (businessProfile !== 'local-services') {
    return {
      applicable: false,
      reason: `Local Maps visibility was not evaluated — inferred business type is "${businessProfile}", not local services`,
      present: null,
      rank: null,
      entries: [],
    };
  }

  const packItem = items.find((i) => i.type === 'local_pack' && i.localPack && i.localPack.length > 0);
  if (!packItem?.localPack) {
    return {
      applicable: true,
      reason: 'No local pack appeared for this query',
      present: null,
      rank: null,
      entries: [],
    };
  }

  const entries = packItem.localPack;
  if (!brand || brand.trim().length < 2) {
    return {
      applicable: true,
      reason: 'No brand name to match against the pack',
      present: null,
      rank: null,
      entries,
    };
  }

  const idx = entries.findIndex((e) => !!e.title && titleIdentifies(e.title, brand));
  return {
    applicable: true,
    reason: idx >= 0 ? 'Found in the local pack' : 'A local pack appeared for this query but did not include this business',
    present: idx >= 0,
    rank: idx >= 0 ? idx + 1 : null,
    entries,
  };
}

function dedupeByDomain(rows: Array<{ domain: string; rank: number }>): Array<{ domain: string; rank: number }> {
  const seen = new Set<string>();
  const out: Array<{ domain: string; rank: number }> = [];
  for (const r of rows) {
    if (seen.has(r.domain)) continue;
    seen.add(r.domain);
    out.push(r);
  }
  return out;
}

/** Exposed for tests / callers that want raw item typing. */
export type { SerpItem };
