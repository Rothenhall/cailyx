import { redirect } from 'next/navigation';

/**
 * CT07 "Page extractability" — moved by P12 (platform_improvement_plan.md §7.2,
 * R33) to the Website group, where it belongs: it measures a live page, and
 * that page's other facts (health, search, visitors) live there too. The
 * Content group keeps no duplicate destination.
 *
 * Nothing was dropped in the move — the capability, its run history and each
 * run's source URL all travel with it, now at
 * `/research/website/page-analysis`.
 *
 * The route is kept as a redirect, not deleted, so an old bookmark or deep
 * link still lands somewhere useful — the same convention `research/prompts`
 * and `research/context` already established for a retired hub.
 */
export default async function PageAnalysisRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/research/website/page-analysis`);
}
