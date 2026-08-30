import type { Metadata } from "next";
import AppShell from "@/components/AppShell";
import "./globals.css";

/**
 * Root metadata for the Cailyx operator frontend.
 */
export const metadata: Metadata = {
  title: "Cailyx",
  description: "AI visibility diagnostics — operator dashboard",
};

/**
 * Root layout: every page renders inside the app shell (header nav + main).
 *
 * @param children - The page content to render
 * @returns The root layout JSX element
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}