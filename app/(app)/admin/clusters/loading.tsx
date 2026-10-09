/**
 * app/(app)/admin/clusters/loading.tsx
 *
 * Shown while /admin/clusters renders (groups + member classification from
 * the backend store). Mirrors the header + table layout.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function ClustersLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3 w-80" />
        </div>
        <Skeleton className="h-9 w-28" />
      </header>
      <SkeletonTable rows={4} cols={4} />
    </div>
  );
}
