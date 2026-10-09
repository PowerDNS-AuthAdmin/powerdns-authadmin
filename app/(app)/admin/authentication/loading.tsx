/**
 * app/(app)/admin/authentication/loading.tsx
 *
 * Shown while /admin/authentication renders. The page folds the OIDC
 * discovery cache and provider reachability into the list, so a slow
 * identity provider holds the render. Mirrors the header + default-method
 * panel + table.
 */

import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function AuthenticationLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-3 w-80" />
        </div>
        <Skeleton className="h-9 w-32" />
      </header>
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-2 h-3 w-96" />
        <Skeleton className="mt-3 h-9 w-72" />
      </div>
      <SkeletonTable rows={4} cols={5} />
    </div>
  );
}
