'use client';

import { useEffect, useState } from 'react';

/**
 * design_plan.md §3.1 chart tokens.
 *
 * Every chart color on the Cailyx web app has to come from the §3.1 custom
 * properties in `src/app/globals.css` — `--primary`, `--success`, `--unmeasured`
 * and friends — so that a chart is never the one place in the product that
 * ignores the theme. `tailwind.config.ts` expresses the same indirection for
 * markup (`bg-primary` → `hsl(var(--primary))`); a chart cannot use a Tailwind
 * class for a stroke, so it reads the property instead.
 *
 * **Why this resolves to a literal `hsl(...)` string rather than passing
 * `"hsl(var(--primary))"` straight to Recharts.** Recharts writes color props
 * onto SVG *presentation attributes*, and `var()` substitution in a
 * presentation attribute is not dependable across browsers. Reading the
 * computed property yields a real color that always paints, while still being
 * derived from the token rather than typed as a hex literal — so redefining a
 * token (G20 / dark mode) still re-colors the chart, via the observer in
 * `useChartTokens`.
 *
 * @module components/charts/tokens
 */

/** The §3.1 tokens a chart is allowed to draw with. */
export const CHART_TOKEN_NAMES = [
  /** The single categorical hue. One series → this hue. */
  'primary',
  'success',
  'warning',
  'danger',
  'info',
  /** Neutral gray for a value that is **not a measurement** (below the sampling
   *  floor, unmeasured). Never a pass and never a failure. */
  'unmeasured',
  /** Text for labels/ticks — chart text never wears the series color. */
  'foreground',
  'muted-foreground',
  /** Hairline grid and axes, one step off the surface. */
  'border',
  /** The surface the marks sit on, for the 2px gap/ring spacers. */
  'surface',
  'canvas',
] as const;

export type ChartTokenName = (typeof CHART_TOKEN_NAMES)[number];

export type ChartTokens = Readonly<Record<ChartTokenName, string>>;

/**
 * The color used when a custom property has not been defined at all (a
 * stylesheet that has not loaded yet). `currentColor` keeps the mark visible
 * and inherits the surrounding text color rather than inventing a hex, so an
 * unstyled chart is still readable and still not a hard-coded brand color.
 */
const ABSENT_TOKEN = 'currentColor';

/**
 * Reads the §3.1 tokens off `:root` and resolves each to a paintable color.
 *
 * Only callable in a browser; `useChartTokens` is the React entry point.
 */
export function readChartTokens(): ChartTokens {
  const styles = getComputedStyle(document.documentElement);
  const entries = CHART_TOKEN_NAMES.map((name) => {
    const raw = styles.getPropertyValue(`--${name}`).trim();
    // globals.css stores the tokens as bare HSL triplets ("224 69% 46%") so
    // Tailwind can compose an alpha channel onto them.
    return [name, raw.length > 0 ? `hsl(${raw})` : ABSENT_TOKEN] as const;
  });
  return Object.fromEntries(entries) as ChartTokens;
}

function sameTokens(a: ChartTokens, b: ChartTokens): boolean {
  return CHART_TOKEN_NAMES.every((name) => a[name] === b[name]);
}

/**
 * The chart tokens, resolved after mount, or `null` before they can be read.
 *
 * Resolving in an effect (rather than during render) keeps the server and the
 * first client render identical — Recharts needs a measured container before it
 * draws anything anyway, so nothing is deferred in practice. A caller renders
 * its chart once this returns a value and its placeholder until then.
 *
 * The observer matters for the same reason the tokens exist: §3.1 defers dark
 * mode, but the whole point of the indirection is that a later theme redefines
 * these properties. Re-reading when the theme attribute changes is what keeps a
 * chart from being frozen on the colors of the theme it first mounted under.
 */
export function useChartTokens(): ChartTokens | null {
  const [tokens, setTokens] = useState<ChartTokens | null>(null);

  useEffect(() => {
    const resolve = () => {
      const next = readChartTokens();
      setTokens((current) => (current && sameTokens(current, next) ? current : next));
    };
    resolve();

    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return tokens;
}
