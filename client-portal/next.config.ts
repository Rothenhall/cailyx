import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Next.js configuration for the Cailyx client portal.
   * Talks to the same backend as frontend/ — same env var name so a shared
   * .env at the repo root (if ever introduced) would just work.
   */
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002",
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
