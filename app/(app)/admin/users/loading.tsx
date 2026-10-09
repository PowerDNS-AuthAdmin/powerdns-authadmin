/**
 * app/(app)/admin/users/loading.tsx
 *
 * Shown while /admin/users renders (user list + per-user assignment counts
 * + last-admin-edit lookups). Mirrors the header + filter chips + table.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function UsersLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </header>
      <div className="flex gap-2">
        {Array.from({ length: 3 }).map((_, idx) => (
          <Skeleton key={idx} className="h-7 w-20 rounded-full" />
        ))}
      </div>
      <SkeletonTable rows={8} cols={5} />
    </div>
  );
}
