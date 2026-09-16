'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe media query hook backing the §3.4 breakpoints. Returns `false`
 * on the server and first client render, then syncs after mount — this
 * intentionally avoids a hydration mismatch rather than trying to guess the
 * viewport on the server.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** §3.4 breakpoint tokens, named to match the design_plan.md prose. */
export const BREAKPOINTS = {
  /** ≥1200px: full navigation and optional evidence panel. */
  desktop: '(min-width: 1200px)',
  /** 768–1199px: collapsible navigation, evidence in an overlay. */
  tablet: '(min-width: 768px) and (max-width: 1199px)',
  /** <768px: single column, menu drawer, cards instead of work tables. */
  mobile: '(max-width: 767px)',
} as const;

export function useIsDesktop(): boolean {
  return useMediaQuery(BREAKPOINTS.desktop);
}

export function useIsMobile(): boolean {
  return useMediaQuery(BREAKPOINTS.mobile);
}
