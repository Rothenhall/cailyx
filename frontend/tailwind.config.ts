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
        night: "var(--night)",
        "night-2": "var(--night-2)",
        "night-line": "var(--night-line)",
        "night-text": "var(--night-text)",
      },
      fontFamily: {
        mono: "var(--mono)",
      },
    },
  },
  plugins: [],
};

export default config;
