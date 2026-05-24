"use client";

/**
 * components/domain/health-bell.tsx
 *
 * Top-bar notification bell for backend health advisories (ADR-0015). The
 * server passes the confirmed advisory set (already debounced + permission-
 * scoped); this renders the count badge + a dropdown. Acknowledging POSTs to
 * the ack route then refreshes so the list reflects the new state.
 *
 * Presentational only — no lib/db / lib/pdns imports (three-layer boundary).
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell } from "lucide-react";
import { apiFetch } from "@/lib/client/api-fetch";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";

export interface BellAdvisory {
  id: string;
  backendId: string;
  backendName: string;
  /** "error" | "warn" | "info". */
  severity: string;
  title: string;
  detail: string;
  acknowledged: boolean;
}

function dotClass(severity: string): string {
  if (severity === "error") return "bg-[color:var(--color-error)]";
  if (severity === "warn") return "bg-[color:var(--color-warn)]";
  return "bg-[color:var(--color-fg-muted)]";
}

export function HealthBell({ advisories }: { advisories: BellAdvisory[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Live-update over the SSE bus (ADR-0015): the poller publishes `health.updated`
  // only when the visible advisory set moves, so we refresh the server-rendered
  // props in place rather than only on navigation. Debounced against a burst.
  const lastRefreshAt = useRef<number>(0);
  useRealtimeEvent(
    (event) => event.type === "health.updated",
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  const unacked = advisories.filter((a) => !a.acknowledged);
  const hasError = unacked.some((a) => a.severity === "error");
  const count = unacked.length;

  async function acknowledge(id: string) {
    setBusy(id);
    try {
      const res = await apiFetch(`/api/admin/backend-advisories/${id}/ack`, { method: "POST" });
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Backend health: ${count} active ${count === 1 ? "issue" : "issues"}`}
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)]"
      >
        <Bell aria-hidden className="h-5 w-5 text-[color:var(--color-fg-muted)]" />
        {count > 0 ? (
          <span
            className={`absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-semibold text-white ${
              hasError ? "bg-[color:var(--color-error)]" : "bg-[color:var(--color-warn)]"
            }`}
          >
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          {/* click-away catcher */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-2 w-96 max-w-[90vw] overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] shadow-lg">
            <div className="border-b border-[color:var(--color-border)] px-3 py-2 text-xs font-semibold tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              Backend health
            </div>
            {advisories.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-[color:var(--color-fg-muted)]">
                All backends healthy.
              </p>
            ) : (
              <ul className="max-h-[60vh] divide-y divide-[color:var(--color-border)] overflow-y-auto">
                {advisories.map((a) => (
                  <li
                    key={a.id}
                    className={`px-3 py-2.5 text-sm ${a.acknowledged ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass(a.severity)}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">{a.title}</span>
                          <Link
                            href={`/admin/servers/${a.backendId}`}
                            className="shrink-0 text-xs text-[color:var(--color-accent)] hover:underline"
                            onClick={() => setOpen(false)}
                          >
                            {a.backendName}
                          </Link>
                        </div>
                        <p className="mt-0.5 text-xs text-[color:var(--color-fg-muted)]">
                          {a.detail}
                        </p>
                        {!a.acknowledged ? (
                          <button
                            type="button"
                            onClick={() => acknowledge(a.id)}
                            disabled={busy === a.id}
                            className="mt-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:underline disabled:opacity-50"
                          >
                            {busy === a.id ? "Dismissing…" : "Dismiss"}
                          </button>
                        ) : (
                          <span className="mt-1 inline-block text-xs text-[color:var(--color-fg-subtle)]">
                            Dismissed
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
