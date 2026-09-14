/**
 * cn — class merger. clsx resolves conditionals; tailwind-merge drops
 * earlier utilities a later one overrides, so a caller's className always
 * wins over a component's defaults. Same as frontend/src/lib/utils.ts.
 *
 * @module lib/utils
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
