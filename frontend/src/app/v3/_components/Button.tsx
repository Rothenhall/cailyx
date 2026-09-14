'use client';

/**
 * Button — the console's button, built on Animate UI's motion primitive.
 *
 * The primitive supplies the physics (a spring hover lift and a tap press);
 * the variants below supply Rothenhall. Two deliberate adjustments:
 *
 *  - `.v3-nopress` opts every one of these out of the CSS `:active` rule in
 *    v3.css. That rule exists for plain `<button>`s; here motion owns the
 *    press, and running both would compound into a double dip.
 *  - `hoverScale` is 1.02, not the library's 1.05. These sit in a dense
 *    console — a full 5% lift on a 320px card reads as a wobble.
 *
 * @module app/v3/_components/Button
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  Button as MotionButton,
  type ButtonProps as MotionButtonProps,
} from '@/components/animate-ui/primitives/buttons/button';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'v3-nopress inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-r2 font-medium ' +
    'transition-colors duration-micro disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        /* brass — the one primary action on a surface */
        primary: 'bg-accent text-bg-raised hover:bg-brass-mid',
        /* the quiet default: a hairline that firms up on hover */
        outline: 'border border-border text-dim hover:border-border-strong hover:text-text',
        /* no chrome until you touch it */
        ghost: 'text-faint hover:bg-bg-inset hover:text-dim',
        /* a brass wash — reads as secondary without competing with primary */
        soft: 'border border-accent-dim bg-accent-dim/14 text-accent hover:bg-accent-dim/24',
        danger: 'bg-danger text-bg-raised hover:opacity-90',
      },
      size: {
        sm: 'h-7 px-2.5 text-caption',
        md: 'h-9 px-3 text-body',
        lg: 'h-10 w-full px-4 text-body',
        icon: 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

/* `MotionButtonProps` is a discriminated union on `asChild`, which a spread
   cannot narrow. The console never renders a button as another element, so
   the branch is dropped rather than threaded through. */
export type ButtonProps = Omit<Extract<MotionButtonProps, { asChild?: false }>, 'ref' | 'asChild'> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <MotionButton
      hoverScale={1.02}
      tapScale={0.97}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
