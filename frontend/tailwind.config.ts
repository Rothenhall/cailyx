import type { Config } from "tailwindcss";

/**
 * Tailwind config — Cailyx console (Rothenhall Partners light theme). Colours
 * are driven by the CSS custom properties in `src/app/globals.css` so components
 * use `bg-bg`, `text-dim`, `border-border`, `text-accent`, `bg-night`, etc.
 */
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-raised": "var(--bg-raised)",
        "bg-inset": "var(--bg-inset)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        text: "var(--text)",
        dim: "var(--text-dim)",
        faint: "var(--text-faint)",
        accent: "var(--accent)",
        "accent-dim": "var(--accent-dim)",
        cognac: "var(--cognac)",
        amber: "var(--amber)",
        red: "var(--red)",
        blue: "var(--blue)",
        /* rothenhall.com brand tokens the console was missing — see v2.css */
        "ink-80": "var(--ink-80)",
        "brass-mid": "var(--brass-mid)",
        "cognac-soft": "var(--cognac-soft)",
        /* semantic status ramp (v2) — brand hues, no new colours */
        ok: "var(--st-ok)",
        warn: "var(--st-warn)",
        danger: "var(--st-danger)",
        idle: "var(--st-idle)",
        /* audit report only — a true traffic-light ramp. An audit's whole job
           is to communicate good / caution / bad at a glance, and the brand's
           all-warm palette can't do that. Scoped to `.v2-audit-ws` in v2.css,
           so the rest of the console keeps its discipline. */
        "a-ok": "var(--a-ok)",
        "a-ok-soft": "var(--a-ok-soft)",
        "a-ok-line": "var(--a-ok-line)",
        "a-warn": "var(--a-warn)",
        "a-warn-soft": "var(--a-warn-soft)",
        "a-warn-line": "var(--a-warn-line)",
        "a-bad": "var(--a-bad)",
        "a-bad-soft": "var(--a-bad-soft)",
        "a-bad-line": "var(--a-bad-line)",
        night: "var(--night)",
        "night-2": "var(--night-2)",
        "night-line": "var(--night-line)",
        "night-text": "var(--night-text)",
        /* shadcn / Animate UI semantic names — every one resolves to a
           Rothenhall value via globals.css, so registry components inherit
           the brand instead of shipping stone grey */
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: { DEFAULT: "var(--card)", foreground: "var(--card-foreground)" },
        popover: { DEFAULT: "var(--popover)", foreground: "var(--popover-foreground)" },
        primary: { DEFAULT: "var(--primary)", foreground: "var(--primary-foreground)" },
        secondary: { DEFAULT: "var(--secondary)", foreground: "var(--secondary-foreground)" },
        muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
        "accent-foreground": "var(--accent-foreground)",
        destructive: { DEFAULT: "var(--destructive)", foreground: "var(--destructive-foreground)" },
        input: "var(--input)",
        ring: "var(--ring)",
      },
      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-sans)",
        /* semantic hook for headings + figures; currently resolves to Outfit */
        display: "var(--font-display)",
      },
      fontSize: {
        /* the v2 type scale — six steps, no half-pixels */
        /* the brand's own eyebrow tracking is .24em, but that is set at
           marketing display sizes — at 10px inside a 320px card it wraps every
           label. .14em keeps the character at console density. */
        eyebrow: ["10px", { lineHeight: "1.25", letterSpacing: "0.14em", fontWeight: "600" }],
        /* the +0.01em that used to sit here was a loosening for a narrow
           face. Outfit is geometric and already wide — measured 13% wider at
           this step — so it is set flush instead. */
        caption: ["11px", { lineHeight: "1.45" }],
        body: ["12px", { lineHeight: "1.55" }],
        ui: ["13px", { lineHeight: "1.4" }],
        title: ["15px", { lineHeight: "1.25", letterSpacing: "-0.015em" }],
        display: ["19px", { lineHeight: "1.2", letterSpacing: "-0.025em" }],
        /* the one big number a panel leads with — a real step, not an
           arbitrary value copy-pasted between panels */
        figure: ["30px", { lineHeight: "1", letterSpacing: "-0.03em" }],
      },
      letterSpacing: {
        eyebrow: "0.14em",
        wide2: "0.025em",
        tight2: "-0.015em",
        display: "-0.025em",
      },
      borderRadius: {
        r1: "4px",
        r2: "8px",
        r3: "12px",
        r4: "16px",
        r5: "24px",
      },
      transitionTimingFunction: {
        brand: "cubic-bezier(0.22, 1, 0.36, 1)",
        spring: "cubic-bezier(0.34, 1.4, 0.64, 1)",
      },
      transitionDuration: {
        micro: "150ms",
        state: "220ms",
        panel: "340ms",
        morph: "520ms",
      },
      boxShadow: {
        /* v4 ships shadow-xs; registry components use it, v3 does not have it */
        xs: "0 1px 2px 0 rgb(26 23 18 / 0.05)",
        e1: "var(--e1)",
        e2: "var(--e2)",
        e3: "var(--e3)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
