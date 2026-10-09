/**
 * app/(app)/admin/settings/loading.tsx
 *
 * Shown while /admin/settings renders. Mirrors the narrow header + form
 * layout: a run of labelled fields in a bordered card.
 */

import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-96" />
      </header>
      <div className="space-y-5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
        {Array.from({ length: 5 }).map((_, idx) => (
          <div key={idx} className="space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-9" style={{ width: "100%" }} />
            <Skeleton className="h-3 w-64" />
          </div>
        ))}
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}
