/**
 * app/(auth)/signup/page.tsx
 *
 * Public self-service signup. Server component - it reads `env` and returns
 * `notFound()` (a real 404) when `SIGNUP_ENABLED` is false, so the page does
 * not exist for deployments that haven't opted in. Mirrors the login route's
 * "feature off → 404" contract on the API side.
 *
 * A signed-in visitor is bounced to the dashboard (same as the login page).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth/get-current-user";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignupPage() {
  // Feature gate - invisible when disabled.
  if (!env.SIGNUP_ENABLED) notFound();

  const current = await getCurrentUser();
  if (current) redirect("/dashboard");

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Sign up with your email and a password. We&apos;ll send a verification link - you must
          verify before you can sign in.
        </p>
      </header>

      <SignupForm turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? undefined} />

      <p className="mt-6 text-xs text-[color:var(--color-fg-muted)]">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
