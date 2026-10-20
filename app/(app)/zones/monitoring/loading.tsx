/**
 * app/(app)/zones/monitoring/loading.tsx
 *
 * Shell shimmer for the zone monitoring page while the server component
 * authenticates. Mirrors the page chrome (back link, header, status strip,
 * chip row, table) so the swap to the real page keeps its layout; the
 * results load client-side afterwards with their own progress note.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function ZoneMonitoringLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-28" />
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-3 w-96 max-w-full" />
      </header>
      <Skeleton className="h-12 w-full rounded-md" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, idx) => (
          <Skeleton key={idx} className="h-7 w-24 rounded-full" />
        ))}
      </div>
      <SkeletonTable rows={8} cols={7} />
    </div>
  );
}
