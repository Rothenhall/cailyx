/**
 * Redaction helper for the Activity module (G15).
 *
 * Every write to ActivityEvent MUST go through `redactChanges` /
 * `redactSummary` — this is the one thing that must not leak per the G15
 * brief. It is deliberately conservative: an unrecognized key with a
 * secret-shaped value gets redacted even if its name is not on the
 * denylist, and long free-text fields (message bodies, raw AI answers) are
 * truncated rather than stored in full.
 *
 * @module redaction.util
 */

/** Key names that are never stored, regardless of value. Case-insensitive substring match. */
const DENYLISTED_KEY_FRAGMENTS = [
  'password',
  'passwordhash',
  'secret',
  'token',
  'apikey',
  'api_key',
  'credential',
  'authorization',
  'cookie',
  'privatekey',
  'accesstoken',
  'refreshtoken',
  'sessionid',
  'clientsecret',
];

/** Key names whose value is free text that must be summarized, never stored verbatim. */
const LONG_TEXT_KEY_FRAGMENTS = ['body', 'message', 'content', 'answer', 'response', 'transcript', 'prompt', 'summary', 'notes'];

/** Key names carrying attribution/contact PII — dropped entirely, not just truncated. */
const PII_KEY_FRAGMENTS = ['email', 'phone', 'ssn', 'address', 'ipaddress', 'ip_address'];

const MAX_TEXT_LENGTH = 140;
const MAX_DEPTH = 4;

/** JWT-shaped or long opaque-token-shaped strings, even under an innocuous key name. */
const SECRET_SHAPED_VALUE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$|^(sk|pk|rk|whsec|Bearer)[_-][A-Za-z0-9]{10,}$/;

function matchesAny(key: string, fragments: string[]): boolean {
  const lower = key.toLowerCase().replace(/[_\s-]/g, '');
  return fragments.some((f) => lower.includes(f.replace(/[_\s-]/g, '')));
}

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (matchesAny(key, DENYLISTED_KEY_FRAGMENTS)) return '[redacted]';
  if (matchesAny(key, PII_KEY_FRAGMENTS)) return '[redacted-pii]';

  if (typeof value === 'string') {
    if (SECRET_SHAPED_VALUE.test(value.trim())) return '[redacted]';
    if (matchesAny(key, LONG_TEXT_KEY_FRAGMENTS) || value.length > MAX_TEXT_LENGTH) {
      return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…[truncated]` : value;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array(${value.length})]`;
    return value.slice(0, 20).map((v, i) => redactValue(`${key}[${i}]`, v, depth + 1));
  }

  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[object]';
    return redactObject(value as Record<string, unknown>, depth + 1);
  }

  return value;
}

function redactObject(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v, depth);
  }
  return out;
}

/**
 * Redact a free-form before/after changes object before it is serialized
 * into `ActivityEvent.changes`. Safe to call with `undefined`/`{}`.
 */
export function redactChanges(changes: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!changes) return {};
  return redactObject(changes);
}

/**
 * Redact a free-text summary line before it is stored in
 * `ActivityEvent.summary`. Truncates and strips anything secret-shaped;
 * never stores a full message body or raw AI answer.
 */
export function redactSummary(summary: string | undefined | null): string | null {
  if (!summary) return null;
  const trimmed = summary.trim();
  if (!trimmed) return null;
  const masked = SECRET_SHAPED_VALUE.test(trimmed) ? '[redacted]' : trimmed;
  return masked.length > MAX_TEXT_LENGTH ? `${masked.slice(0, MAX_TEXT_LENGTH)}…[truncated]` : masked;
}
