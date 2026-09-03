'use client';

/**
 * useFocusTrap — keeps Tab inside a modal surface and hands focus back to
 * whatever opened it on close. Without this you can tab straight out of the
 * Workspace panel and land, invisibly, in the console behind it.
 *
 * Only for genuinely modal surfaces. The Flywheel's theme popup is deliberately
 * non-modal — it is click-through so you can jump wedge to wedge — so it keeps
 * Escape-to-close but is not trapped.
 *
 * @module app/v2/_lib/useFocusTrap
 */

import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const restoreTo = document.activeElement as HTMLElement | null;

    /* offsetParent is null for display:none subtrees — skip those */
    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed',
      );

    /* move focus in, but don't steal it from something already inside */
    if (!root.contains(document.activeElement)) {
      const first = focusables()[0];
      (first ?? root).focus?.();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // the opener may have unmounted while the modal was up
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus?.();
    };
  }, [active, ref]);
}
