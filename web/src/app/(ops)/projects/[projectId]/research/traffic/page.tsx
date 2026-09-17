import { redirect } from 'next/navigation';

/**
 * TA01 "Traffic & acquisition" — merged by P12 (platform_improvement_plan.md
 * §7.1, R09) into the unified **Website** screen, where visitor sessions sit
 * beside website health and Google search facts instead of on their own page.
 * The visitors view is `<Website>?tab=visitors`.
 *
 * The route is kept as a redirect, not deleted, so an old bookmark or deep
 * link still lands somewhere useful — the same convention `research/prompts`
 * and `research/context` already established for a retired hub.
 */
export default async function TrafficRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/research/website?tab=visitors`);
}
