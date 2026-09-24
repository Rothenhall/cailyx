import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cailyx Admin Console",
  description: "Run diagnostics for a client site: Day-1 report, AEO audit, competitor analysis.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
