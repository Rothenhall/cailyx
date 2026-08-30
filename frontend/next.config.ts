import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Next.js configuration for the Cailyx frontend.
   * Environment variable is used to configure the backend API URL.
   */
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002",
  },
};

export default nextConfig;
