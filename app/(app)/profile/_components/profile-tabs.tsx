"use client";

/**
 * app/(app)/profile/_components/profile-tabs.tsx
 *
 * Tab system for the profile page. The URL hash drives which tab is
 * visible:
 *
 *   /profile             → defaults to the first tab (Account)
 *   /profile#sessions    → opens the Sessions tab
 *   /profile#api-tokens  → opens the API tokens tab
 *
 * Browser back/forward + pasting a hash-bearing URL both work,
 * because the only source-of-truth is `window.location.hash`. No
 * router writes, no state mirror.
 *
 * Hidden tabs are kept in the DOM (server-rendered server-side, then
 * `hidden`-toggled on the client) so:
 *   - SSR renders every panel — good for paste-from-URL flows and
 *     for the brief moment between paint + hydration.
 *   - Switching tabs is instant — no remount, no re-fetch of any
 *     server data the panels already received as props.
 *
 * Per-tab content is passed as children. Wrap each panel in
 * <ProfileTabPanel id="…">; the container scans React.Children for
 * the active id and `hidden`-toggles the rest.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";

export interface TabSpec {
  id: string;
  label: string;
}

interface ContainerProps {
  tabs: TabSpec[];
  /** Tab shown when the URL has no hash or an unknown hash. */
  defaultTab: string;
  children: ReactNode;
}

export function ProfileTabsContainer({ tabs, defaultTab, children }: ContainerProps) {
  // Server-side render: trust the defaultTab. Client-side first paint:
  // sync to whatever the URL hash actually says BEFORE the user sees
  // the wrong panel. The hydration mismatch from this is acceptable —
  // hidden-panel content is identical SSR vs CSR, only the `hidden`
  // attribute on each panel differs by one render.
  const [activeId, setActiveId] = useState<string>(defaultTab);

  useEffect(() => {
    function readHash() {
      const raw = window.location.hash.replace(/^#/, "");
      const found = tabs.find((t) => t.id === raw);
      setActiveId(found ? found.id : defaultTab);
    }
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => {
      window.removeEventListener("hashchange", readHash);
    };
  }, [tabs, defaultTab]);

  return (
    <>
      <nav
        aria-label="Profile sections"
        className="-mx-2 flex flex-wrap gap-1 border-b border-[color:var(--color-border)] pb-3 text-sm"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <a
              key={tab.id}
              href={`#${tab.id}`}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "rounded-md bg-[color:var(--color-bg-subtle)] px-2 py-1 font-medium text-[color:var(--color-fg)]"
                  : "rounded-md px-2 py-1 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)]"
              }
            >
              {tab.label}
            </a>
          );
        })}
      </nav>

      <ActivePanelGate activeId={activeId}>{children}</ActivePanelGate>
    </>
  );
}

/**
 * Filter wrapper: hides every `<ProfileTabPanel>` child whose `id`
 * doesn't match `activeId`. Tolerates non-panel children passed
 * through verbatim — useful for banners that should show across all
 * tabs (e.g. mustChangePassword warning).
 */
function ActivePanelGate({ activeId, children }: { activeId: string; children: ReactNode }) {
  // `React.Children.map` preserves keys and only walks the immediate
  // children — that's the shape we want. We deliberately don't
  // recurse into arbitrary descendants; the page composes the
  // section list as a flat tuple at the top level.
  const wrapped: ReactNode[] = [];
  // Iterate manually so non-element children pass through.
  const childArray = Array.isArray(children) ? children : [children];
  for (const c of childArray) {
    if (isProfileTabPanel(c)) {
      const id = c.props.id;
      wrapped.push(
        <div key={id} hidden={id !== activeId}>
          {c}
        </div>,
      );
    } else {
      wrapped.push(c as ReactNode);
    }
  }
  return <>{wrapped}</>;
}

function isProfileTabPanel(node: unknown): node is ReactElement<{ id: string }> {
  return (
    typeof node === "object" && node !== null && "type" in node && node.type === ProfileTabPanel
  );
}

/**
 * Wrapper that marks its children as belonging to a specific tab.
 * Server-renderable — it's only a tag for the container's filter.
 */
export function ProfileTabPanel({ id, children }: { id: string; children: ReactNode }) {
  // The `id` lives on the wrapper element too so screen readers /
  // operators inspecting the DOM can correlate panel ↔ nav link.
  return (
    <section id={id} className="scroll-mt-20">
      {children}
    </section>
  );
}
