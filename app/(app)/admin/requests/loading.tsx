/**
 * app/(app)/admin/requests/loading.tsx
 *
 * Shown while /admin/requests renders. The request log is a wide, filtered
 * query over the PowerDNS HTTP trace table; mirrors the header + filter bar
 * + table so the swap is silent.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function RequestsLoading() {
  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-3 w-80" />
      </header>
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3">
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, idx) => (
            <div key={idx} className="space-y-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7" style={{ width: "100%" }} />
            </div>
          ))}
        </div>
      </div>
      <SkeletonTable rows={10} cols={6} />
    </div>
  );
}
