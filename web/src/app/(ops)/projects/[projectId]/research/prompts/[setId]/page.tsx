import { redirect } from 'next/navigation';

/**
 * QS02 "Prompt set detail" — merged by P13 (platform_improvement_plan.md
 * §8.1) under AI visibility's staff advanced panel. Kept as a redirect so a
 * deep link to a specific set still resolves.
 */
export default async function PromptSetDetailRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string; setId: string }>;
}) {
  const { projectId, setId } = await params;
  redirect(`/projects/${projectId}/research/ai/sets/${setId}`);
}
