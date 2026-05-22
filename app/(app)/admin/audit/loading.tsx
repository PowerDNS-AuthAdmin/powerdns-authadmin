/**
 * app/(app)/admin/audit/loading.tsx
 *
 * The audit query scans a potentially large table (one row per state-
 * changing action across the entire app) with filters + pagination. On a
 * fresh install this resolves instantly, but on a long-running deployment
 * with millions of rows it can take a second or two — well past the point
 * where "stay on the old page" feels like the app froze. Hence the
 * skeleton.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function AuditLoading() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-3 w-80" />
      </header>
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="space-y-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-8" style={{ width: "100%" }} />
            </div>
          ))}
        </div>
      </div>
      <SkeletonTable rows={10} cols={5} />
    </div>
  );
}
