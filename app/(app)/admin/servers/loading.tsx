/**
 * app/(app)/admin/servers/loading.tsx
 *
 * Shown while /admin/servers renders. The page reads the live reachability
 * store and, on a cold cache, probes every backend - the slowest list in the
 * admin area. Mirrors the header + table layout so the swap is silent.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function ServersLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-3 w-80" />
        </div>
        <Skeleton className="h-9 w-28" />
      </header>
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}
