"use client";

/**
 * components/ui/app-shell.tsx
 *
 * Responsive chrome for the authenticated app. On `md+` the sidebar is a static
 * 16rem column (the classic desktop layout); below `md` it becomes an off-canvas
 * drawer toggled by the hamburger in the top bar, with a tap-to-dismiss backdrop.
 *
 * The server layout owns auth + builds the sidebar/header content (RBAC-gated),
 * then hands it here as props - this component only manages the mobile drawer
 * state, so the data-fetching stays on the server.
 *
 * Drawer accessibility: while closed below `md` the <aside> is `inert` and
 * `aria-hidden` - a translated-off-screen panel is otherwise still in the tab
 * order and the accessibility tree, so a phone user would tab through twenty
 * invisible links before reaching the page. Opening moves focus to the first
 * nav link; closing hands it back to the hamburger.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { HeaderStatusChip } from "@/components/realtime/header-status-chip";

/** Tailwind's `md` breakpoint - where the drawer becomes a static column. */
const DESKTOP_QUERY = "(min-width: 768px)";

export const MAIN_CONTENT_ID = "main-content";

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
  // Assume desktop until measured: a static sidebar must never start inert,
  // and the first client effect corrects phones before they can interact.
  const [isDesktop, setIsDesktop] = useState(true);
  const pathname = usePathname();
  const asideRef = useRef<HTMLElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

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

  // Focus follows the drawer: into the first link on open, back to the
  // hamburger on close (including closes triggered by navigation and Esc).
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      asideRef.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      hamburgerRef.current?.focus();
    }
  }, [open]);

  const drawerHidden = !isDesktop && !open;

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Skip link - the first tab stop on every page; visible only while
          focused so sighted mouse users never see it. */}
      <a
        href={`#${MAIN_CONTENT_ID}`}
        className="sr-only z-50 rounded-md bg-[color:var(--color-accent)] px-3 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      {/* Backdrop - mobile only, fades in with the drawer. */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Sidebar - off-canvas drawer on mobile, static column on md+. */}
      <aside
        ref={asideRef}
        inert={drawerHidden || undefined}
        aria-hidden={drawerHidden || undefined}
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
            ref={hamburgerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            className="-ml-1 rounded-md p-2 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)] md:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          {/* Single SSE chip for the whole app - its label is driven per page
              via <HeaderStatusMode/> in components that own a "synced" notion. */}
          <HeaderStatusChip />
          <div className="ml-auto flex items-center gap-3">{headerControls}</div>
        </header>

        {/* `min-h-0` is the canonical flexbox-clipping fix: a `flex-1` child
            without it can grow beyond its parent's height when its content
            is taller, defeating `overflow-y-auto` and leaking a second
            outer scroll region.

            `relative` makes this the containing block for absolutely-positioned
            descendants - notably Tailwind `sr-only` spans, which are
            `position: absolute`. `overflow-y-auto` alone does NOT establish a
            containing block, so without `relative` those spans escape the scroll
            region and anchor to the document at their full-content-height static
            position, stretching <html> past the viewport. That re-introduced the
            exact "scroll-in-scroll, black at the bottom" bug on the zones list at
            high row counts even with `min-h-0` already in place (each row's
            screen-reader label is one such span; 50 of them push the document to
            ~2000px tall behind a correctly-sized 100dvh shell).

            `tabIndex={-1}` lets the skip link land focus here without adding the
            region to the Tab order; `outline-none` because that programmatic
            focus shouldn't draw a ring around the whole page. */}
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="relative min-h-0 flex-1 overflow-y-auto p-4 outline-none sm:p-6 lg:p-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
