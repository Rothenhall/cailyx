import type { Metadata } from "next";
import { Urbanist } from "next/font/google";
import "./globals.css";

/**
 * Urbanist — the single app-wide typeface, for both consoles. Exposed as
 * `--font-urbanist`, which `globals.css` feeds into the `--mono` and
 * `--font-display` tokens so every `font-mono` / `font-display` /
 * `var(--mono)` reference resolves to it with no per-component churn.
 */
const urbanist = Urbanist({
  subsets: ["latin"],
  variable: "--font-urbanist",
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
    <html lang="en" data-theme="light" className={urbanist.variable}>
      <body className="min-h-screen bg-bg text-text font-sans antialiased">{children}</body>
    </html>
  );
}
