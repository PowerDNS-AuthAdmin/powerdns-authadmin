"use client";

/**
 * components/ui/app-shell.tsx
 *
 * Responsive chrome for the authenticated app. On `md+` the sidebar is a static
 * 16rem column (the classic desktop layout); below `md` it becomes an off-canvas
 * drawer toggled by the hamburger in the top bar, with a tap-to-dismiss backdrop.
 *
 * The server layout owns auth + builds the sidebar/header content (RBAC-gated),
 * then hands it here as props — this component only manages the mobile drawer
 * state, so the data-fetching stays on the server.
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { HeaderStatusChip } from "@/components/realtime/header-status-chip";

export function AppShell({
  sidebar,
  headerControls,
  children,
}: {
  sidebar: React.ReactNode;
  headerControls: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer after navigating (tapping a nav link changes the route).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Esc closes the drawer; only matters while it's open on mobile.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Backdrop — mobile only, fades in with the drawer. */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Sidebar — off-canvas drawer on mobile, static column on md+. */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-80 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {sidebar}
      </aside>

      {/* Main column. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            className="-ml-1 rounded-md p-2 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)] md:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          {/* Single SSE chip for the whole app — its label is driven per page
              via <HeaderStatusMode/> in components that own a "synced" notion. */}
          <HeaderStatusChip />
          <div className="ml-auto flex items-center gap-3">{headerControls}</div>
        </header>

        {/* `min-h-0` is the canonical flexbox-clipping fix: a `flex-1` child
            without it can grow beyond its parent's height when its content
            is taller, defeating `overflow-y-auto` and leaking a second
            outer scroll region. Previously this surfaced on the zones list
            at high page sizes (100+) as the "scroll-in-scroll, half the
            page goes black at the bottom" bug. */}
        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
