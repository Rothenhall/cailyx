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
export default async function RootPage() {
  const userType = await getSessionUserType();

  if (userType === 'client') redirect('/client');
  if (userType === 'operator') redirect('/ops');
  redirect('/sign-in');
}
