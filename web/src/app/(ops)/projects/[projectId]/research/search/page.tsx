import { redirect } from 'next/navigation';

/**
 * SE01 "Search performance" — merged by P12 (platform_improvement_plan.md §7.1,
 * R09) into the unified **Website** screen, where Search Console facts sit
 * beside website health and visitor sessions instead of on their own page.
 * The Google search view is `<Website>?tab=search`.
 *
 * The route is kept as a redirect, not deleted, so an old bookmark or deep
 * link still lands somewhere useful — the same convention `research/prompts`
 * and `research/context` already established for a retired hub.
 */
export default async function SearchPerformanceRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/research/website?tab=search`);
}
