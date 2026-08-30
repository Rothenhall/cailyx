/**
 * Authority discovery helpers — pure classification + extraction.
 *
 * Turns SERP items and AI-answer citations into de-duplicated authority
 * candidates, classified by type and scored for relevance. No I/O.
 *
 * @module authority.discovery
 */

import { hostOf } from '../../common/utils/subject-match';
import { AUTHORITY_LIMITS } from './authority.types';
import type { AuthorityCandidateType, WorkingCandidate } from './authority.types';

/** Hosts that are never useful authority targets. */
const JUNK_HOSTS = new Set([
  'google.com',
  'google.co.uk',
  'bing.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'pinterest.com',
  'translate.google.com',
]);

const PODCAST_HINTS = ['podcast', 'podcasts.apple.com', 'open.spotify.com', 'overcast.fm', 'pod.link'];
const COMMUNITY_HINTS = ['reddit.com', 'news.ycombinator.com', 'ycombinator.com', 'discourse', 'forum', 'community', 'stackexchange.com', 'quora.com', 'lobste.rs'];
const DIRECTORY_HINTS = ['g2.com', 'capterra.com', 'getapp.com', 'producthunt.com', 'sourceforge.net', 'alternativeto.net', 'slant.co', 'directory'];
const NEWSLETTER_HINTS = ['substack.com', 'beehiiv.com', 'buttondown', 'newsletter'];

/** Classify a domain + title into an authority candidate type. */
export function classify(domain: string, title: string): AuthorityCandidateType {
  const d = domain.toLowerCase();
  const t = (title || '').toLowerCase();
  const hit = (hints: string[]) => hints.some((h) => d.includes(h) || t.includes(h));

  if (hit(PODCAST_HINTS)) return 'podcast';
  if (hit(COMMUNITY_HINTS)) return 'community';
  if (hit(DIRECTORY_HINTS)) return 'directory';
  if (hit(NEWSLETTER_HINTS)) return 'newsletter';
  if (/\b(best|top \d+|top-\d+|alternatives|vs\.?|comparison|roundup|listicle)\b/.test(t)) return 'listicle';
  return 'publication';
}

function relevanceScore(type: AuthorityCandidateType, title: string, category: string, rank: number | null): number {
  let r = 0.5;
  const catTerms = category.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (catTerms.some((w) => title.toLowerCase().includes(w))) r += 0.2;
  if (rank !== null && rank <= 5) r += 0.15;
  if (type === 'listicle' || type === 'directory' || type === 'community') r += 0.1;
  return Math.min(1, Number(r.toFixed(4)));
}

export interface ExcludeSet {
  subjectHost: string;
  competitorHosts: string[];
}

function isExcluded(domain: string, ex: ExcludeSet): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  if (!d || d.length < 4) return true;
  if (JUNK_HOSTS.has(d)) return true;
  if (ex.subjectHost && d.endsWith(ex.subjectHost)) return true;
  if (ex.competitorHosts.some((c) => c && d.endsWith(c))) return true;
  return false;
}

/** Extract candidates from one SERP's organic + AI-overview reference items. */
export function candidatesFromSerp(
  keyword: string,
  items: Array<{ type: string; domain: string | null; url: string | null; title: string | null; rankAbsolute: number | null; references?: string[] }>,
  category: string,
  ex: ExcludeSet,
): WorkingCandidate[] {
  const out: WorkingCandidate[] = [];
  for (const it of items) {
    if (it.type === 'organic' && it.domain && it.url) {
      if (isExcluded(it.domain, ex)) continue;
      const type = classify(it.domain, it.title ?? '');
      out.push({
        domain: it.domain.toLowerCase().replace(/^www\./, ''),
        url: it.url,
        title: (it.title ?? it.domain).slice(0, 200),
        type,
        discoveredVia: `serp:${keyword}`,
        rank: it.rankAbsolute ?? null,
        relevance: relevanceScore(type, it.title ?? '', category, it.rankAbsolute ?? null),
        rationale: `Ranks${it.rankAbsolute ? ` #${it.rankAbsolute}` : ''} for "${keyword}" — a page the target audience already reads.`,
      });
    }
    if (it.type === 'ai_overview' && Array.isArray(it.references)) {
      for (const ref of it.references) {
        const host = hostOf(ref);
        if (isExcluded(host, ex)) continue;
        const type = classify(host, '');
        out.push({
          domain: host,
          url: ref,
          title: host,
          type,
          discoveredVia: `serp:${keyword}`,
          rank: null,
          relevance: relevanceScore(type, '', category, null) + 0.1,
          rationale: `Cited by the AI Overview for "${keyword}" — a source the answer engine already trusts.`,
        });
      }
    }
  }
  return out;
}

/** Candidates from AI-answer citations recorded on journeys / measurement. */
export function candidatesFromCitations(
  citationUrls: string[],
  origin: 'journey' | 'measurement',
  category: string,
  ex: ExcludeSet,
): WorkingCandidate[] {
  const seen = new Set<string>();
  const out: WorkingCandidate[] = [];
  for (const url of citationUrls) {
    const host = hostOf(url);
    if (!host || seen.has(host) || isExcluded(host, ex)) continue;
    seen.add(host);
    const type = classify(host, '');
    out.push({
      domain: host,
      url: /^https?:\/\//.test(url) ? url : `https://${host}/`,
      title: host,
      type,
      discoveredVia: `citation:${origin}`,
      rank: null,
      relevance: Math.min(1, relevanceScore(type, '', category, null) + 0.15),
      rationale: `Cited in ${origin} AI answers about this topic — earning a mention here directly shapes what the AI repeats.`,
    });
  }
  return out;
}

/** Merge, dedupe by domain (keep best relevance), cap. */
export function mergeCandidates(lists: WorkingCandidate[][]): WorkingCandidate[] {
  const byDomain = new Map<string, WorkingCandidate>();
  for (const list of lists) {
    for (const c of list) {
      const existing = byDomain.get(c.domain);
      if (!existing || c.relevance > existing.relevance) {
        byDomain.set(c.domain, existing ? { ...c, discoveredVia: `${existing.discoveredVia}; ${c.discoveredVia}` } : c);
      } else {
        existing.discoveredVia = `${existing.discoveredVia}; ${c.discoveredVia}`;
      }
    }
  }
  return [...byDomain.values()]
    .sort((a, b) => b.relevance - a.relevance || a.domain.localeCompare(b.domain))
    .slice(0, AUTHORITY_LIMITS.maxCandidates);
}
