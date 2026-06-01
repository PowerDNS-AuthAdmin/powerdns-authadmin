/**
 * app/(app)/zones/loading.tsx
 *
 * Shown while /zones is fetching the zone list from PowerDNS. The PDNS API
 * call goes over the network and is the slow link - 200ms–1s+ is normal,
 * sometimes more when the backend is behind a reverse proxy. The shimmer
 * mirrors the page layout (header + table) so the swap is silent.
 *
 * Not added for DB-only pages (admin/users, admin/teams, profile, etc.)
 * because their queries run in <50ms - a flash of skeleton on every
 * navigation is worse UX than nothing.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function ZonesLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-64" />
        </div>
      </header>
      <SkeletonTable rows={8} cols={4} />
    </div>
  );
}
