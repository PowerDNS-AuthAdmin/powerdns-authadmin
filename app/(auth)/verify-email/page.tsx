/**
 * app/(auth)/verify-email/page.tsx
 *
 * Public (no-session) page that redeems an email-verification link.
 * It lives under `(auth)` rather than `(app)` because signup users
 * can't sign in until their email is verified — login returns 403 for
 * unverified local accounts when SIGNUP_ENABLED — so they have no
 * session and the page must be reachable while logged out. The signed
 * token in `?token=` is the bearer credential; the API route
 * (`/api/auth/email/verify`) validates its HMAC and marks the email
 * verified without requiring a session. A logged-in operator clicking
 * the same link works identically (CSRF is enforced when their session
 * cookie rides along).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { VerifyEmailForm } from "./verify-form";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <>
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Open the verification link your administrator sent you. The link is recorded in the
            audit log under <code className="ml-1">auth.email.verify.sent</code>.
          </p>
        </header>
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          <Link href="/login" className="underline">
            ← Back to sign in
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Confirming your email address…
        </p>
      </header>
      <VerifyEmailForm token={token} />
      <p className="mt-6 text-xs text-[color:var(--color-fg-muted)]">
        <Link href="/login" className="underline">
          ← Back to sign in
        </Link>
      </p>
    </>
  );
}
