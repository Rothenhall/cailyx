import { redirect } from 'next/navigation';

/**
 * QS01 "Prompt library" — merged by P13 (platform_improvement_plan.md §8.1)
 * into "AI visibility", with question-set management moved to its staff
 * advanced panel at `/research/ai/sets` (§8.2: "Keep model/provider/repeats/
 * budget settings in an advanced staff panel").
 *
 * The route is kept as a redirect, not deleted, so an old bookmark or deep
 * link still lands somewhere useful — the same convention `research/context`
 * already established for a retired hub.
 */
export default async function PromptLibraryRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/research/ai/sets`);
}
