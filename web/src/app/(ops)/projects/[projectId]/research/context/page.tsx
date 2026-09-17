import { redirect } from 'next/navigation';

/**
 * AE05 "Site context" — retired by P02 (design_plan.md §9.1: "Move Site
 * Context to Business information outside Research/Performance"; §20.3
 * migration rule 6: "Redirect old list routes once replacements work; retain
 * detail URLs").
 *
 * The screen this used to render (extracted facts, source pages, rebuild) is
 * superseded by `/projects/:projectId/business-info`, which adds the
 * confirmed-vs-suggested grouping and the field-level correction the old page
 * explicitly said it could not do ("There is no endpoint that accepts a
 * corrected service, ICP, pain point or market" — that endpoint now exists).
 * The route itself is kept, as a redirect, rather than deleted, so an old
 * bookmark or deep link still lands somewhere useful.
 */
export default async function SiteContextRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/business-info`);
}
