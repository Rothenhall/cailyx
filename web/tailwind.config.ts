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
        xl: 'var(--radius-dialog)',
        /* the soft grouped-container corner — nav cards, panel groups */
        '2xl': 'var(--radius-group)'
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        /* Montserrat (graphite theme kit) — see globals.css. Applied by the
           base-layer h1–h4 rule, and available as `font-display` for the few
           headings that are not real heading elements. Never for numerals:
           those are read as data. */
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)']
      },
      /* Graphite theme kit's softened variable-font weight scale —
         Montserrat is a variable font, so these non-standard values render
         exactly as specified instead of snapping to the nearest static
         weight. */
      fontWeight: {
        normal: '425',
        medium: '525',
        semibold: '625',
        bold: '725'
      },
      /**
       * design_plan.md §3.1's scale, carrying the brand kit's body ramp
       * (label / caption / body / body-lg) and its display tracking. The token
       * NAMES stay §3.1's because they are used at ~400 call sites; only the
       * values move. The kit bans arbitrary sizes like `text-[0.95rem]`, so
       * anything needing a type step uses one of these six.
       */
      /* The bottom of this scale is compressed relative to the kit's original
         ramp. At the 72% root set in globals.css the old 0.8rem `meta` step
         computed to ~9.2px — under what is comfortable to read, and it carries
         section labels, timestamps and captions. The small steps are lifted
         and the gaps between them narrowed, so the density stays but nothing
         lands below ~10px. Order is unchanged: meta < table < body < subsection. */
      fontSize: {
        /* kit --text-label: meta, tags, footnotes */
        meta: ['0.9rem', { lineHeight: '1.45' }],
        /* kit --text-caption: secondary body, table cells */
        table: ['0.98rem', { lineHeight: '1.6' }],
        /* kit --text-body: default prose */
        body: ['1.06rem', { lineHeight: '1.6' }],
        /* kit --text-body-lg: ledes and subsection headings */
        subsection: ['1.16rem', { lineHeight: '1.55' }],
        /* kit display-md floor, tracked per --rh-tracking-display-md */
        title: ['1.9rem', { lineHeight: '1.06', letterSpacing: '-0.012em' }],
        /* kit display-lg floor, tracked per --rh-tracking-display-lg */
        kpi: ['2.4rem', { lineHeight: '1.01', letterSpacing: '-0.018em' }]
      },
      /* §3.1's layout constants, in rem so they follow the root UI scale set
         in globals.css (240px / 64px / 1440px / 920px at a 16px root). */
      spacing: {
        nav: '15rem',
        topbar: '4rem'
      },
      maxWidth: {
        content: '90rem',
        reading: '57.5rem'
      },
      /* graphite theme kit's shadow shape (softer, lower-opacity, more
         spread) retinted with the kit's own ink instead of graphite's
         grayscale. */
      boxShadow: {
        overlay: '0 8px 24px hsl(var(--shadow) / 0.08), 0 2px 6px hsl(var(--shadow) / 0.04)',
        /* graphite's smallest shadow step — the lift under a selected/raised
           chip (active nav item, filter pill), not a full overlay. */
        chip: '0 1px 2px hsl(var(--shadow) / 0.06), 0 8px 16px hsl(var(--shadow) / 0.08)',
        /* the elevation ladder, shared with the CSS vars in globals.css */
        soft: 'var(--shadow-soft)',
        medium: 'var(--shadow-medium)',
        strong: 'var(--shadow-strong)',
        /* an inset highlight along the top edge plus an ambient lift — what
           makes a grouped container read as a raised, softly-lit block. */
        group:
          'inset 0 1px 0 hsl(var(--surface-raised) / 0.7), 0 10px 22px hsl(var(--shadow) / 0.05)',
        none: 'none'
      },
      /* graphite theme kit's motion scale — see the matching CSS vars in
         globals.css. */
      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)'
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)'
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
