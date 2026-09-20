import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration for the Cailyx web app.
 *
 * Every color here resolves to a CSS custom property defined in
 * `src/app/globals.css`, which is the single source of truth for
 * design_plan.md §3.1's token table. The role names are §3.1's; the values
 * those roles resolve to come from the Rothenhall Partners brand kit v1.1.0
 * (`Brand/tokens/brand.css`). Components must never write a raw hex value —
 * that is what makes a future theme/branding override (G20) possible without
 * touching component source, and what kept this re-skin to one stylesheet.
 *
 * Each mapping is written as `hsl(var(--token) / <alpha-value>)` rather than
 * the shorter `hsl(var(--token))` this file used before. Both compile, but only
 * the first lets Tailwind honour an opacity modifier: against a
 * `hsl(var(--token))` mapping a class like `bg-night/80` emits no rule at all.
 * 25 such classes were in `src/` and all 25 were dead, so every tinted status
 * border (`border-danger/30`, `border-warning/40`, …) and every alpha hover
 * state was silently rendering at full strength or not at all. The tokens hold
 * bare `H S L` triplets precisely so this form is available.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'hsl(var(--canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'hsl(var(--surface) / <alpha-value>)',
          raised: 'hsl(var(--surface-raised) / <alpha-value>)',
          sunken: 'hsl(var(--surface-sunken) / <alpha-value>)'
        },
        border: 'hsl(var(--border) / <alpha-value>)',
        'border-strong': 'hsl(var(--border-strong) / <alpha-value>)',
        input: 'hsl(var(--border-strong) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        /* The kit's readable spotlight accent (cognac-deep), used for link copy
           now that --primary is an ink button fill rather than an accent. */
        link: 'hsl(var(--link) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
        },
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
          hover: 'hsl(var(--primary-hover) / <alpha-value>)',
          subtle: 'hsl(var(--primary-subtle) / <alpha-value>)'
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
          subtle: 'hsl(var(--success-subtle) / <alpha-value>)'
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
          subtle: 'hsl(var(--warning-subtle) / <alpha-value>)'
        },
        danger: {
          DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
          foreground: 'hsl(var(--danger-foreground) / <alpha-value>)',
          subtle: 'hsl(var(--danger-subtle) / <alpha-value>)'
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          foreground: 'hsl(var(--info-foreground) / <alpha-value>)',
          subtle: 'hsl(var(--info-subtle) / <alpha-value>)'
        },
        unmeasured: {
          DEFAULT: 'hsl(var(--unmeasured) / <alpha-value>)',
          foreground: 'hsl(var(--unmeasured-foreground) / <alpha-value>)',
          subtle: 'hsl(var(--unmeasured-subtle) / <alpha-value>)'
        },
        /* Brand kit "night" — the dramatic dark bands. Modal scrims use
           bg-night rather than bg-black so the dark sits in the same warm
           family as the paper surfaces it dims. */
        night: {
          DEFAULT: 'hsl(var(--night) / <alpha-value>)',
          raised: 'hsl(var(--night-2) / <alpha-value>)',
          line: 'hsl(var(--night-line) / <alpha-value>)'
        },
        background: 'hsl(var(--canvas) / <alpha-value>)',
        card: {
          DEFAULT: 'hsl(var(--surface) / <alpha-value>)',
          foreground: 'hsl(var(--foreground) / <alpha-value>)'
        },
        popover: {
          DEFAULT: 'hsl(var(--surface) / <alpha-value>)',
          foreground: 'hsl(var(--foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'hsl(var(--surface-sunken) / <alpha-value>)',
          foreground: 'hsl(var(--foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'hsl(var(--surface-sunken) / <alpha-value>)',
          foreground: 'hsl(var(--foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
          foreground: 'hsl(var(--danger-foreground) / <alpha-value>)'
        }
      },
      borderRadius: {
        sm: 'calc(var(--radius-input) - 2px)',
        md: 'var(--radius-input)',
        lg: 'var(--radius-card)',
        xl: 'var(--radius-dialog)'
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        /* Jost. Applied by the base-layer h1–h4 rule in globals.css, and
           available as `font-display` for the few headings that are not real
           heading elements. Never for numerals: those are read as data. */
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)']
      },
      /**
       * design_plan.md §3.1's scale, carrying the brand kit's body ramp
       * (label / caption / body / body-lg) and its display tracking. The token
       * NAMES stay §3.1's because they are used at ~400 call sites; only the
       * values move. The kit bans arbitrary sizes like `text-[0.95rem]`, so
       * anything needing a type step uses one of these six.
       */
      fontSize: {
        /* kit --text-label: meta, tags, footnotes */
        meta: ['0.8rem', { lineHeight: '1.45' }],
        /* kit --text-caption: secondary body, table cells */
        table: ['0.9rem', { lineHeight: '1.6' }],
        /* kit --text-body: default prose, and the iOS-safe input minimum */
        body: ['1.02rem', { lineHeight: '1.6' }],
        /* kit --text-body-lg: ledes and subsection headings */
        subsection: ['1.12rem', { lineHeight: '1.55' }],
        /* kit display-md floor, tracked per --rh-tracking-display-md */
        title: ['1.9rem', { lineHeight: '1.06', letterSpacing: '-0.012em' }],
        /* kit display-lg floor, tracked per --rh-tracking-display-lg */
        kpi: ['2.4rem', { lineHeight: '1.01', letterSpacing: '-0.018em' }]
      },
      spacing: {
        nav: '240px',
        topbar: '64px'
      },
      maxWidth: {
        content: '1440px',
        reading: '920px'
      },
      boxShadow: {
        overlay: '0 8px 24px -4px hsl(var(--shadow) / 0.12), 0 2px 6px -2px hsl(var(--shadow) / 0.08)',
        none: 'none'
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0'
          },
          to: {
            height: 'var(--radix-accordion-content-height)'
          }
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)'
          },
          to: {
            height: '0'
          }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out'
      }
    }
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
