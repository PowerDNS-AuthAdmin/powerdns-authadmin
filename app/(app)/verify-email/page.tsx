/**
 * app/(app)/verify-email/page.tsx
 *
 * Lives under `(app)` so the operator must be signed in before they
 * can complete a verification. That's the safer threat model: even
 * with a leaked link, the attacker still needs the operator's
 * password to claim the verified-email checkmark.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { VerifyEmailForm } from "./verify-form";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { user } = await requireUserForPage();
  const { token } = await searchParams;

  if (user.emailVerifiedAt) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Email already verified</h1>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          Your account's email <code>{user.email}</code> is verified. No further action needed.
        </p>
        <Link href="/dashboard" className="text-sm underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          Click the verification link your administrator sent you. The link is recorded in the audit
          log under
          <code className="ml-1">auth.email.verify.sent</code>.
        </p>
        <Link href="/dashboard" className="text-sm underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
      <p className="text-sm text-[color:var(--color-fg-muted)]">
        Confirm to mark <code>{user.email}</code> as verified.
      </p>
      <VerifyEmailForm token={token} />
    </div>
  );
}
