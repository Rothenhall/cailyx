import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";

/**
 * Montserrat — the single app-wide typeface (titles, subtitles, descriptions,
 * data — everything). Ported in from the Graphite theme kit alongside its
 * radius/shadow/motion scale (see globals.css, tailwind.config.ts, v2.css,
 * v3.css); Rothenhall's colour tokens are untouched.
 *
 * Exposed as `--font-montserrat`, which globals.css feeds into `--font-sans`,
 * `--mono` and `--font-display`, so every `font-sans` / `font-mono` /
 * `font-display` reference across both consoles resolves to it with no
 * per-component churn. Montserrat ships as a variable font, so it is loaded
 * without a fixed weight list — the softened 425/525/625/725 weight scale in
 * tailwind.config.ts (Graphite's own weights) is available directly.
 */
const montserrat = Montserrat({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-montserrat",
  display: "swap",
});

/**
 * Root metadata for the Cailyx operator console.
 */
export const metadata: Metadata = {
  title: "Cailyx",
  description: "Cailyx — AI visibility, GTM, and revenue operations as one engine.",
};

/**
 * Root layout. The console is its own full-viewport shell; the layout just sets
 * the warm-paper ground (Rothenhall light theme).
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: browser extensions (Grammarly, LanguageTool…)
    // inject attributes onto <html>/<body> before React hydrates
    // (`data-gr-ext-installed`, `data-new-gr-c-s-check-loaded`). This suppresses
    // the mismatch on these two elements only — one level deep, so real
    // mismatches inside the app still warn.
    <html lang="en" data-theme="light" className={montserrat.variable} suppressHydrationWarning>
      <body
        className="min-h-screen bg-bg text-text font-sans antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
