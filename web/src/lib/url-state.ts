/**
 * Pure encode/decode helpers for keeping filter and selection state in the
 * URL (design_plan.md §3.2: "Keep filters in the URL so copied links
 * reproduce the same project/run view").
 *
 * These are framework-agnostic on purpose — `URLSearchParams` in, a plain
 * object out — so they are trivial to unit test and so the React binding
 * (`hooks/useUrlState.ts`) stays a thin wrapper around `next/navigation`.
 */

/** The value shapes a screen may keep in the URL. `undefined` means absent. */
export type UrlStateValue = string | number | boolean | string[] | undefined;

export type UrlStateShape = Record<string, UrlStateValue>;

/**
 * Reads a typed state object out of `URLSearchParams`, using `defaults` both
 * to know each key's expected type (string vs number vs boolean vs array)
 * and to fill in values missing from the URL.
 */
export function decodeUrlState<T extends UrlStateShape>(
  params: URLSearchParams,
  defaults: T,
): T {
  const result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (!params.has(key)) continue;
    const raw = params.get(key);
    const defaultValue = defaults[key];

    if (Array.isArray(defaultValue)) {
      (result as UrlStateShape)[key] = params.getAll(key).flatMap((v) => v.split(','));
    } else if (typeof defaultValue === 'number') {
      const n = Number(raw);
      (result as UrlStateShape)[key] = Number.isFinite(n) ? n : defaultValue;
    } else if (typeof defaultValue === 'boolean') {
      (result as UrlStateShape)[key] = raw === 'true';
    } else {
      (result as UrlStateShape)[key] = raw ?? defaultValue;
    }
  }
  return result;
}

/**
 * Serializes a state object into `URLSearchParams`, dropping any key that
 * equals its default so the URL stays as short as the view actually needs
 * (an unfiltered list does not carry `?status=all&owner=all&...`).
 */
export function encodeUrlState<T extends UrlStateShape>(
  state: T,
  defaults: T,
  base?: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(base?.toString());
  for (const key of Object.keys(state)) {
    params.delete(key);
    const value = state[key];
    const defaultValue = defaults[key];
    const isDefault =
      Array.isArray(value) && Array.isArray(defaultValue)
        ? arraysEqual(value, defaultValue)
        : value === defaultValue;

    if (value === undefined || value === '' || isDefault) continue;

    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
