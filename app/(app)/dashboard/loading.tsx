/**
 * Route-transition skeleton for /dashboard.
 *
 * Rendered the moment the user clicks the dashboard link — covers the
 * gap until the streaming server response begins flushing. Without
 * this file, Next.js falls back to "nothing" while the server-side
 * data fetch (sampler probe to PDNS over WAN) blocks the first byte.
 */
export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-6">
      <header>
        <div className="h-8 w-72 rounded bg-[color:var(--color-bg-subtle)]" />
        <div className="mt-2 h-4 w-96 rounded bg-[color:var(--color-bg-subtle)]" />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4"
          >
            <div className="h-3 w-24 rounded bg-[color:var(--color-bg-muted)]" />
            <div className="mt-2 h-7 w-16 rounded bg-[color:var(--color-bg-muted)]" />
          </div>
        ))}
      </div>

      <div className="h-9 border-b border-[color:var(--color-border)]">
        <div className="flex gap-6">
          <div className="h-4 w-32 rounded bg-[color:var(--color-bg-subtle)]" />
          <div className="h-4 w-28 rounded bg-[color:var(--color-bg-subtle)]" />
        </div>
      </div>

      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-md border border-[color:var(--color-border)] p-4">
          <div className="h-5 w-48 rounded bg-[color:var(--color-bg-subtle)]" />
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, j) => (
              <div
                key={j}
                className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3"
              >
                <div className="h-3 w-32 rounded bg-[color:var(--color-bg-muted)]" />
                <div className="mt-3 h-40 rounded bg-[color:var(--color-bg-muted)]" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
