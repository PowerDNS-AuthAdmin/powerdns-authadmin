/**
 * app/(app)/zones/auto-ptr/page.tsx
 *
 * Fleet-wide reverse DNS reconciler. Every A/AAAA record across every zone,
 * side by side with the PTR that currently exists for its address in the
 * reverse zones this installation hosts, with multi-select rectification.
 *
 * The page itself is thin: the report is slow (it reads every zone on every
 * backend), so the client component fetches it after the shell has painted
 * and owns the loading state. Permission: global `record.read`; the rectify
 * route re-checks write permission per reverse zone.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { PtrReconciler } from "./_components/ptr-reconciler";

export const metadata: Metadata = { title: "Reverse DNS" };

export default async function AutoPtrPage() {
  await requireUserForPage({ can: "record.read" });

  return (
    <div className="space-y-6">
      <Link href="/zones" className="text-sm text-[color:var(--color-accent)] hover:underline">
        ← Back to zones
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Reverse DNS</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Compares every A/AAAA record with the PTR in the hosted reverse zones. Rectifying writes
          the PTR exactly as the record editor&apos;s auto-PTR would, with the same permissions and
          audit rows.
        </p>
      </header>
      <PtrReconciler />
    </div>
  );
}
