/**
 * app/(app)/admin/roles/loading.tsx
 *
 * Shown while /admin/roles renders. Mirrors the header + table layout.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function RolesLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
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
