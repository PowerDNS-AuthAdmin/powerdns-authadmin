import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" label="Loading notifications" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-8 w-full max-w-lg" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
