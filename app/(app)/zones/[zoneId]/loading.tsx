/**
 * app/(app)/zones/[zoneId]/loading.tsx
 *
 * Initial-load shimmer for the zone detail page. Matches the rendered
 * page's chrome - Back link · header · stats grid · tab strip · body -
 * so the swap to the real page doesn't shift layout.
 *
 * The dnssec/ and metadata/ child segments have their own loading.tsx
 * files mirroring this same chrome so tab navigation between segments
 * doesn't appear as a different page.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function ZoneDetailLoading() {
  return (
    <div className="space-y-6">
      <ZoneDetailChromeSkeleton />
      <SkeletonTable rows={10} cols={5} />
    </div>
  );
}

/**
 * Exported so sibling-segment loading files (dnssec, metadata) can
 * render the identical header + tab strip while only their body
 * skeleton differs.
 */
export function ZoneDetailChromeSkeleton() {
  return (
    <>
      <Skeleton className="h-4 w-32" />
      <header className="space-y-3">
        <Skeleton className="h-8 w-72" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="space-y-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="h-3 w-64" />
      </header>
      <div className="flex gap-6 border-b border-[color:var(--color-border)] pb-3">
        {Array.from({ length: 6 }).map((_, idx) => (
          <Skeleton key={idx} className="h-4 w-20" />
        ))}
      </div>
    </>
  );
}
