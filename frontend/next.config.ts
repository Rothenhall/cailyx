import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Next.js configuration for the Cailyx frontend.
   * Environment variable is used to configure the backend API URL.
   */
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002",
    // Optional: when set, the login page shows a "continue as demo" button
    // that logs straight into this account. Leave unset to hide it.
    NEXT_PUBLIC_DEMO_EMAIL: process.env.NEXT_PUBLIC_DEMO_EMAIL || "",
    NEXT_PUBLIC_DEMO_PASSWORD: process.env.NEXT_PUBLIC_DEMO_PASSWORD || "",
  },
};

export default nextConfig;
