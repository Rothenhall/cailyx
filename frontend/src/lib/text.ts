/**
 * Small text helpers for turning raw tool output into readable UI copy.
 *
 * @module lib/text
 */

/**
 * A technical-audit finding's `detail` / `recommendedFix` can arrive as a raw
 * error blob (JSON, box-drawing art, stack noise). Pull out the human sentence
 * and flatten it to a single line.
 */
export function cleanFindingText(raw: string | null | undefined, max = 180): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  try {
    const j = JSON.parse(s) as { error?: unknown };
    if (j && typeof j === 'object' && typeof j.error === 'string') s = j.error;
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
