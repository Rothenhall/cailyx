/**
 * Deterministic subject/competitor detection over a raw AI-surface answer.
 *
 * Mirrors `measurement.service`'s private `extractObservation` so the swarm
 * layer (`journey`, `serp-intelligence`, `authority`) scores answers the same
 * way the moat does — string/host matching only, no LLM, fully reproducible.
 *
 * @module common/utils/subject-match
 */

/** Normalize a URL (or bare host) to a lowercase registrable host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase();
  }
}

export interface SubjectMatch {
  /** Subject brand name or domain appears in the answer text. */
  mentioned: boolean;
  /** A citation resolves to the subject's domain. */
  cited: boolean;
  citedUrl: string | null;
  /** 1-based rank of the subject citation among all citations, or null. */
  position: number | null;
  /** Competitor names detected in the answer text (verbatim from the input list). */
  competitorsSeen: string[];
}

/**
 * Score one answer for a subject and a competitor set.
 *
 * @param text            Answer text as shown to a user of the surface.
 * @param citations       Cited URLs in surface result order.
 * @param subject         `{ name, domain }` of the client/project.
 * @param competitorNames Competitor display names to look for.
 */
export function scoreAnswerForSubject(
  text: string,
  citations: string[],
  subject: { name: string; domain: string },
  competitorNames: string[],
): SubjectMatch {
  const textLower = (text || '').toLowerCase();

  const subjectHost = (subject.domain || '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .toLowerCase();
  const nameLower = (subject.name || '').toLowerCase();

  // Mention = full name appears, OR the longest brand token (>= 4 chars,
  // whole-word) appears — surfaces often use the bare brand.
  let nameMatch = false;
  if (nameLower.length > 2 && textLower.includes(nameLower)) {
    nameMatch = true;
  } else {
    const tokens = nameLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (tokens.length > 0) {
      const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a));
      nameMatch = new RegExp(
        '(?:^|[^a-z0-9])' + longest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)',
      ).test(textLower);
    }
  }

  const mentioned = nameMatch || (subjectHost.length > 3 && textLower.includes(subjectHost));

  let cited = false;
  let citedUrl: string | null = null;
  let position: number | null = null;
  (citations || []).forEach((url, idx) => {
    if (!cited && subjectHost.length > 3 && hostOf(url).endsWith(subjectHost)) {
      cited = true;
      citedUrl = url;
      position = idx + 1;
    }
  });

  const competitorsSeen = (competitorNames || []).filter(
    (name) => name.length > 2 && textLower.includes(name.toLowerCase()),
  );

  return { mentioned, cited, citedUrl, position, competitorsSeen };
}

/** Parse a `Project.competitors` JSON column (array of `{name,domain}` or bare strings). */
export function parseCompetitors(raw: string | null | undefined): Array<{ name: string; domain: string | null }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ name?: string; domain?: string | null } | string>;
    return parsed
      .map((c) =>
        typeof c === 'string'
          ? { name: c, domain: null }
          : { name: (c?.name ?? '').trim(), domain: c?.domain ?? null },
      )
      .filter((c) => c.name.length > 0);
  } catch {
    return [];
  }
}
