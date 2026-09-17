import { redirect } from 'next/navigation';

/**
 * CT03 "Generate content" — replaced by P09 (platform_improvement_plan.md
 * §13.6) with a **contextual** generation dialog, and the route is kept as a
 * redirect rather than deleted so an old bookmark or deep link still lands
 * somewhere useful — the same convention `research/prompts` and
 * `research/context` already established for a retired destination.
 *
 * §13.6's rule is why there is no replacement screen to send this to:
 *
 * > "Generation is not a destination. It is an action inside a context, with
 * > the context prefilled."
 *
 * A standalone "Generate" page is exactly the shape that rule forbids — it has
 * to ask the user for everything the surrounding work already knows (which
 * piece, which plan, which style, which market), and it invites starting
 * content from nothing. So generation is now reached from the contexts that
 * actually carry that information:
 *
 *  - **New content** on the content list (`/content`) opens the dialog at
 *    step 1 with the project's confirmed business profile and target markets
 *    already read in.
 *  - **Start from an idea** on the Ideas view promotes the opportunity through
 *    its own idempotent conversion, then opens the dialog with the topic.
 *  - **Prepare draft from a content plan** reuses the plan's title, audience
 *    and angle, and cannot start without an approved plan.
 *  - **Create another version** on a piece adds a revision to that piece, with
 *    its brief and pinned style.
 *  - **Update this page** routes into the existing refresh mechanism (§13.11)
 *    instead of re-generating blindly.
 *
 * The dialog's own review step still states the estimated cost, the output
 * count, the approval prerequisites, and whether the result is a new piece or
 * a revision — those are §13.6's requirements, and they moved with the action
 * rather than being lost with the page.
 */
export default async function GenerateContentRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/content`);
}
