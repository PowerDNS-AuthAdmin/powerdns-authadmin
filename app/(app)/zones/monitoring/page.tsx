/**
 * app/(app)/zones/monitoring/page.tsx
 *
 * Fleet-wide zone monitoring: every hosted zone, checked from the outside on
 * a schedule, with the findings of the last pass.
 *
 * The page itself is thin: results live in the monitor's memory and are
 * fetched by the client component after the shell has painted, which also
 * lets it poll for the first cycle after a boot. Permission: global
 * `zone.read`, the same gate the API routes apply.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { ZoneMonitorPanel } from "./_components/zone-monitor-panel";

export const metadata: Metadata = { title: "Zone Monitoring" };

export default async function ZoneMonitoringPage() {
  await requireUserForPage({ can: "zone.read" });

  return (
    <div className="space-y-6">
      <Link href="/zones" className="text-sm text-[color:var(--color-accent)] hover:underline">
        ← Back to zones
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Zone Monitoring</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Every hosted zone is checked from the outside on a schedule: the delegation at the parent,
          each nameserver&apos;s answers, the DNSSEC chain, what resolvers see, open zone transfers
          and reverse DNS. Findings here also feed the notification bell.
        </p>
      </header>
      <ZoneMonitorPanel />
    </div>
  );
}
