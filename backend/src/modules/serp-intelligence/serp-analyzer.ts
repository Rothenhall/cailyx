/**
 * SERP analyzer — pure function turning a normalized provider response into the
 * per-query metrics we persist (subject rank, AI-Overview presence, competitor
 * presence, source spread).
 *
 * @module serp-intelligence.serp-analyzer
 */

import { hostOf, scoreAnswerForSubject } from '../../common/utils/subject-match';
import type { SerpItem, SerpResponse } from './serp-intelligence.types';

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
