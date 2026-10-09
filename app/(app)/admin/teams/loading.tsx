/**
 * app/(app)/admin/teams/loading.tsx
 *
 * Shown while /admin/teams renders. Mirrors the header + table layout.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function TeamsLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </header>
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}
