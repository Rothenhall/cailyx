import type { NextConfig } from 'next';

/**
 * The browser never talks to the NestJS backend directly: every call goes to a
 * same-origin `/api/*` path, which is served by the route handlers in
 * `src/app/api/`. Those attach the access token from the HttpOnly session
 * cookie and own the refresh race.
 *
 * Note there is deliberately NO rewrite here. A rewrite would bypass the route
 * handlers, and nothing in the browser can turn an HttpOnly cookie into an
 * Authorization header — the proxy has to run on the server. The backend origin
 * is read from `BACKEND_ORIGIN` inside those handlers.
 *
 * design_plan.md §10.5 requires this same-origin session boundary; it also
 * keeps vendor keys and Google refresh grants server-side.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo has lockfiles at both the root and in this app; without this Next
  // guesses the workspace root from the first one it finds and traces the wrong
  // tree into the build output.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
