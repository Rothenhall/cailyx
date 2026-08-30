import type { Config } from "tailwindcss";

/**
 * Tailwind config — Cailyx dark console. Colours are driven by the CSS custom
 * properties in `src/app/globals.css` (Rothenhall Partners brand palette) so
 * components use `bg-bg`, `text-dim`, `border-border`, `text-accent`, etc.
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
      },
      fontFamily: {
        mono: "var(--mono)",
      },
    },
  },
  plugins: [],
};

export default config;
