/**
 * app/(app)/zones/auto-ptr/loading.tsx
 *
 * Shell shimmer for the reverse DNS reconciler while the server component
 * authenticates. Mirrors the page chrome (back link, header, chip strip,
 * table) so the swap to the real page keeps its layout; the report itself
 * loads client-side afterwards with its own progress note.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function AutoPtrLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-28" />
      <header className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-3 w-96 max-w-full" />
      </header>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, idx) => (
          <Skeleton key={idx} className="h-7 w-24 rounded-full" />
        ))}
      </div>
      <SkeletonTable rows={8} cols={6} />
    </div>
  );
}
