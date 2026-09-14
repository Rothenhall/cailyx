import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

/**
 * Poppins — the single app-wide typeface, same as frontend/. Exposed as
 * --font-poppins, which globals.css feeds into --font-sans/--mono/--font-display.
 */
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cailyx Client Portal",
  description: "Client status, reports, and messages — Rothenhall Partners / Cailyx.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: browser extensions inject attributes onto
    // <html>/<body> before React hydrates — see frontend/src/app/layout.tsx
    // for the same note.
    <html lang="en" data-theme="light" className={poppins.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-text font-sans antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
