import { redirect } from 'next/navigation';

/**
 * Content "Calendar" — collapsed into the one content calendar by P10
 * (platform_improvement_plan.md §6.4, §6.5, §20.3).
 *
 * This route was never a calendar. It was a content readiness table — assets,
 * approvals and publish destinations, with two columns hardcoded to the absence
 * of a schedule store ("Not assignable yet", "No schedule store") and a notice
 * saying in as many words that Cailyx stored no publish date for a content
 * asset, so a calendar drawn from it would be invented rather than read. The
 * schedule store now exists (`ContentSchedule`), and §6.4 allows exactly one
 * content calendar, so the honest move is not to give this screen one too.
 *
 * The route is kept as a redirect, not deleted, so an old bookmark or deep link
 * still lands somewhere useful — the same convention `research/prompts` and
 * `research/context` already established for a retired hub. §20.3: duplicate
 * calendar destinations are collapsed into the real one by redirecting, never
 * by deleting the old path or by reusing it for different contents.
 *
 * Anything this screen did that is genuinely not calendar work moved with it
 * rather than disappearing: the asset library and its approval state are on the
 * content library, and publish destinations are on Connections.
 */
export default async function ContentCalendarRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/calendar`);
}
