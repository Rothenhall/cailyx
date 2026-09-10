/**
 * cn — the class merger every shadcn-registry component (and therefore every
 * Animate UI component) imports from `@/lib/utils`.
 *
 * clsx resolves the conditionals; tailwind-merge then drops earlier utilities
 * that a later one overrides, so a caller's `className` always wins over a
 * component's defaults instead of depending on stylesheet order.
 *
 * @module lib/utils
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
