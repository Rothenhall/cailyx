import type { Config } from "tailwindcss";

/**
 * Tailwind config — Okara Terminal dark theme. Colours are driven by the CSS
 * custom properties defined in `src/app/globals.css` so components can use
 * `bg-bg`, `text-dim`, `border-border`, `text-accent`, etc.
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
        amber: "var(--amber)",
        red: "var(--red)",
        blue: "var(--blue)",
      },
      fontFamily: {
        mono: "var(--mono)",
      },
    },
  },
  plugins: [],
};

export default config;
