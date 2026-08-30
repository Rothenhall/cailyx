import type { Metadata } from "next";
import "./globals.css";

/**
 * Root metadata for the Cailyx operator console.
 */
export const metadata: Metadata = {
  title: "Cailyx",
  description: "Cailyx — AI visibility, GTM, and revenue operations as one engine.",
};

/**
 * Root layout. The terminal is its own full-viewport shell, so the layout only
 * sets the dark ground.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark">
      <body className="min-h-screen bg-bg text-text font-mono antialiased">{children}</body>
    </html>
  );
}
