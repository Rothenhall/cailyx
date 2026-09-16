/**
 * Branding input validation — G20.
 *
 * `OrganizationSettings.primaryColor` is documented as "Hex, applied as a CSS
 * custom property override", which means it ends up inside a stylesheet. A
 * value that is not a hex colour is therefore not a cosmetic problem: it is an
 * unvalidated string in a CSS declaration. This module rejects anything that
 * is not a hex literal rather than passing it through and hoping the browser
 * ignores it.
 *
 * @module lib/branding.util
 */

import { BadRequestException } from '@nestjs/common';

/**
 * `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. The leading `#` is optional on
 * input and always present on output.
 */
const HEX_COLOR_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Validate and normalize a hex colour.
 *
 * @param input e.g. `#0A7`, `0a7c1e`, `#0A7C1EFF`.
 * @returns the lowercase `#`-prefixed literal, e.g. `#0a7c1e`.
 * @throws BadRequestException the value is not a hex colour. Named CSS colours
 *   (`rebeccapurple`), `rgb()`/`hsl()` functions and `var(...)` are refused on
 *   purpose: accepting them would mean accepting arbitrary CSS in a field the
 *   model documents as hex.
 */
export function normalizeHexColor(input: string): string {
  const raw = (input ?? '').trim();
  const match = HEX_COLOR_RE.exec(raw);
  if (!match) {
    throw new BadRequestException(
      `primaryColor "${input}" is not a hex colour — expected #rgb, #rgba, #rrggbb or #rrggbbaa`,
    );
  }
  return `#${match[1].toLowerCase()}`;
}

/**
 * Non-throwing form, for read paths that must report a stored value rather
 * than fail on it (e.g. a legacy row written before validation existed).
 * @returns the normalized literal, or null when the stored value is not hex.
 */
export function tryNormalizeHexColor(input: string | null | undefined): string | null {
  try {
    return normalizeHexColor(input ?? '');
  } catch {
    return null;
  }
}

/** The CSS custom property the client overrides for primary brand colour. */
export const PRIMARY_COLOR_CSS_VARIABLE = '--brand-primary';

/**
 * Build the CSS custom property overrides for a settings row.
 *
 * Only properties that actually have a value are returned — an override set to
 * an empty string would blank the token instead of leaving the application
 * default in place.
 */
export function brandingCssVariables(primaryColor: string | null): Record<string, string> {
  const normalized = tryNormalizeHexColor(primaryColor);
  return normalized ? { [PRIMARY_COLOR_CSS_VARIABLE]: normalized } : {};
}
