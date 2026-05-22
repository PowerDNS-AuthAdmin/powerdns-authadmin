/**
 * app/page.tsx
 *
 * Root landing route. We don't render a public landing page (the app is an
 * internal admin tool, not a marketing site); redirect based on auth state.
 *
 * The redirect happens server-side so an unauthenticated user never sees a
 * flash of dashboard chrome before being bounced to /login.
 */

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/get-current-user";

export default async function HomePage() {
  const current = await getCurrentUser();
  redirect(current ? "/dashboard" : "/login");
}
