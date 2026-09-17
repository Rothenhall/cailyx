import { redirect } from 'next/navigation';
import { getSessionUserType } from '@/lib/session';

/**
 * Root entry point.
 *
 * design_plan.md §2.3 "Shared entry" routes a signed-in user straight to the
 * workspace that matches their session type, and everyone else to sign-in.
 *
 * This reads the session type from a cookie rather than calling the backend:
 * it is a routing hint, and the destination page does the real authorization.
 * A wrong hint costs one redirect, never an access decision.
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Carry the feedback reviewer token through the redirect.
  //
  // The FasterFixes widget reads `ff_token` from `window.location` on mount and
  // then stores it in localStorage; if the parameter is dropped before any page
  // renders, it never gets captured and the widget renders nothing — silently,
  // because the provider's config fetch is wrapped in a bare try/catch.
  //
  // A redirect does not forward the query string on its own, so a review link
  // pointing at the site root (`/?ff_token=…`) used to lose the token here.
  // Only this one parameter is forwarded: echoing arbitrary query parameters
  // into a redirect is how tracking junk ends up laundered into a clean URL.
  const ffToken = params.ff_token;
  const suffix = typeof ffToken === 'string' ? `?ff_token=${encodeURIComponent(ffToken)}` : '';

  const userType = await getSessionUserType();

  if (userType === 'client') redirect(`/client${suffix}`);
  if (userType === 'operator') redirect(`/ops${suffix}`);
  redirect(`/sign-in${suffix}`);
}
