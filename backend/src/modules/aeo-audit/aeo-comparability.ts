/**
 * When two AEO audits may be compared number-for-number.
 *
 * Same rule the `results` cohort applies (results/README #3) and
 * `AeoVisibilityService.history()` flags: a different question set, a different
 * set of engines (which also encodes transport — `cloro-chatgpt` vs
 * `chatgpt-browser`) or a different set of markets is a methodology break, and
 * a delta across it would measure the change of method, not of the brand.
 *
 * Pure — no Prisma, no DI — so the audit module and the progress module read
 * the one rule without importing each other.
 *
 * @module aeo-comparability
 */

export interface ComparableAuditFields {
  querySetId: string | null;
  /** JSON string[] as stored on `AeoAudit.surfaces`. */
  surfaces: string;
  /** JSON string[] as stored on `AeoAudit.markets`. */
  markets: string;
}

/**
 * A stable key for the audit's methodology, or null when the audit has no
 * question set recorded (legacy rows), which makes it comparable to nothing.
 */
export function auditComparabilityKey(audit: ComparableAuditFields): string | null {
  if (!audit.querySetId) return null;
  const surfaces = parseList(audit.surfaces);
  const markets = parseList(audit.markets);
  return [audit.querySetId, surfaces.join(','), markets.join(',')].join('|');
}

export function areAuditsComparable(a: ComparableAuditFields, b: ComparableAuditFields): boolean {
  const ka = auditComparabilityKey(a);
  return ka !== null && ka === auditComparabilityKey(b);
}

function parseList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((v): v is string => typeof v === 'string'))].sort();
  } catch {
    return [];
  }
}
