/**
 * Small text helpers for turning raw tool output into readable UI copy.
 *
 * @module lib/text
 */

/** metric keys measured in milliseconds — shown in seconds once they're large */
const MS_KEYS = new Set(['lcp', 'fcp', 'inp', 'ttfb', 'fid', 'tbt', 'si', 'tti']);

/** one `key value` from a metrics blob, or null if it carries no information */
function formatMetric(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (value === -1) return null; // the "not measured" sentinel
    if (MS_KEYS.has(key.toLowerCase())) {
      return value >= 1000 ? `${key} ${(value / 1000).toFixed(2)}s` : `${key} ${Math.round(value)}ms`;
    }
    return `${key} ${Math.round(value * 100) / 100}`;
  }
  if (typeof value === 'boolean') return value ? key : null;
  if (typeof value === 'string' && value.trim()) return `${key} ${value.trim()}`;
  return null;
}

/**
 * A technical-audit finding's `detail` / `recommendedFix` can arrive as a raw
 * error blob (JSON, box-drawing art, stack noise) or as a bare metrics object
 * (the Core Web Vitals payload). Pull out the human sentence — or render the
 * metrics as readable pairs — and flatten to a single line.
 */
export function cleanFindingText(raw: string | null | undefined, max = 180): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  try {
    const j = JSON.parse(s) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const err = (j as { error?: unknown }).error;
      if (typeof err === 'string') {
        s = err;
      } else {
        const parts = Object.entries(j as Record<string, unknown>)
          .map(([k, v]) => formatMetric(k, v))
          .filter((x): x is string => x !== null);
        if (parts.length) s = parts.join(' · ');
      }
    }
  } catch {
    /* not JSON — keep as-is */
  }
  s = s
    .replace(/[╔╗╚╝║═╭╮╰╯│─]+/g, ' ')
    .replace(/<3 Playwright Team/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
