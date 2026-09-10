import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

/**
 * Poppins — the single app-wide typeface (titles, subtitles, descriptions,
 * data — everything).
 *
 * Exposed as `--font-poppins`, which globals.css feeds into `--font-sans`,
 * `--mono` and `--font-display`, so every `font-sans` / `font-mono` /
 * `font-display` reference across both consoles resolves to it with no
 * per-component churn. Poppins is not a variable font, so the weights the
 * type scale actually uses (400 body, 500 medium, 600 semibold, 700 the
 * audit report's bold labels; 300 for the rare light caption) are loaded
 * explicitly.
 */
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-poppins",
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
    <html lang="en" data-theme="light" className={poppins.variable} suppressHydrationWarning>
      <body
        className="min-h-screen bg-bg text-text font-sans antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
