/**
 * app/(app)/admin/tsig-keys/loading.tsx
 *
 * Shown while /admin/tsig-keys renders. The page lists keys straight from
 * the selected PowerDNS backend (and the peers it correlates against), so a
 * slow backend holds the whole page. Mirrors the header + table layout.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function TsigKeysLoading() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-80" />
      </header>
      <Skeleton className="h-9 w-64" />
      <SkeletonTable rows={5} cols={4} />
    </div>
  );
}
