import type { Config } from "tailwindcss";

/**
 * Tailwind config — client-portal. Colours are driven by the same CSS custom
 * properties as frontend/ (ported verbatim from frontend/src/app/globals.css)
 * so this app reads as the same product, not a second brand.
 */
const config: Config = {
  content: [
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
        "ink-80": "var(--ink-80)",
        "brass-mid": "var(--brass-mid)",
        "cognac-soft": "var(--cognac-soft)",
        /* semantic status ramp — brand hues, no new colours */
        ok: "var(--st-ok)",
        warn: "var(--st-warn)",
        danger: "var(--st-danger)",
        idle: "var(--st-idle)",
        /* report view only — a true traffic-light ramp, same exception v2.css
           makes for the audit workspace: a score band / severity needs to
           read good/caution/bad at a glance, which the all-warm brand
           palette can't do. Scoped to `.report-view` in globals.css. */
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
      },
      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-sans)",
        display: "var(--font-display)",
      },
      fontSize: {
        eyebrow: ["10px", { lineHeight: "1.25", letterSpacing: "0.14em", fontWeight: "600" }],
        caption: ["11px", { lineHeight: "1.45" }],
        body: ["12px", { lineHeight: "1.55" }],
        ui: ["13px", { lineHeight: "1.4" }],
        title: ["15px", { lineHeight: "1.25", letterSpacing: "-0.015em" }],
        display: ["19px", { lineHeight: "1.2", letterSpacing: "-0.025em" }],
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
        e1: "var(--e1)",
        e2: "var(--e2)",
        e3: "var(--e3)",
      },
    },
  },
  plugins: [],
};

export default config;
