import { redirect } from 'next/navigation';

/**
 * P05 (platform_improvement_plan.md §11.1, R18) — "Presence insights" merged
 * into the single "Online presence" screen at `/research/presence` (business
 * profile, reviews and social activity now live there as its activity view).
 *
 * This route survives as a redirect rather than a 404 — §20.3's migration
 * convention — so an old bookmark or deep link still resolves somewhere useful
 * instead of breaking.
 *
 * P16 turned this from a `useEffect` + `router.replace` into the same
 * server-side `redirect()` every other retired route uses. The client-side
 * version was worse in three ways that only show up for the reader: it
 * rendered an empty document before the swap, it needed JavaScript to resolve
 * at all, and it was the one exception the §20.3 check could not assert
 * uniformly. The destination is unchanged.
 *
 * @module presence-insights-redirect
 */
export default async function PresenceInsightsRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/research/presence?tab=activity`);
}
