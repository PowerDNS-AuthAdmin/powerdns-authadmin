/**
 * app/(auth)/reset-password/page.tsx
 *
 * Two surfaces in one page:
 *   - `?token=` present → reset form (enter + confirm new password)
 *   - `?token=` absent  → forgot form (enter email, get an audit row +
 *                         generic "if account exists" copy)
 *
 * Both submit to the corresponding API route. Server-side validation
 * happens at /api/auth/{forgot,reset}-password — this page only does
 * the visible affordance.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-form";
import { ResetPasswordForm } from "./reset-form";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {token ? "Set a new password" : "Forgot password"}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          {token
            ? "Enter a new password to complete the reset."
            : "We'll record a reset link in the audit log; your administrator will share it with you."}
        </p>
      </header>
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <ForgotPasswordForm turnstileSiteKey={env.TURNSTILE_SITE_KEY} />
      )}
      <p className="mt-6 text-xs text-[color:var(--color-fg-muted)]">
        <Link href="/login" className="underline">
          ← Back to sign in
        </Link>
      </p>
    </>
  );
}
