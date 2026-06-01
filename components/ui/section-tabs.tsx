"use client";

/**
 * components/ui/section-tabs.tsx
 *
 * URL-hash-driven section tabs. Used by /profile and the admin
 * user-edit page.
 *
 *   <SectionTabs tabs={[…]} defaultTab="account">
 *     <SectionTabPanel id="account">…</SectionTabPanel>
 *     <SectionTabPanel id="sessions">…</SectionTabPanel>
 *   </SectionTabs>
 *
 * Hash drives visibility:
 *   /page             → defaults to the first tab
 *   /page#sessions    → opens "sessions"
 *
 * Hidden tabs stay in the DOM (SSR-rendered, then display-toggled on
 * the client) so switching tabs is instant - no remount, no re-fetch
 * of server data the panels already received as props.
 *
 * Panel identity uses a `data-section-tab` marker attribute rather
 * than component-function equality: Turbopack HMR / production
 * transforms can reissue the function and break a `node.type === X`
 * check, but the marker attribute survives both.
 */

import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

export interface SectionTabSpec {
  id: string;
  label: string;
}

interface ContainerProps {
  tabs: SectionTabSpec[];
  /** Tab shown when the URL has no hash or an unknown hash. */
  defaultTab: string;
  children: ReactNode;
}

export function SectionTabs({ tabs, defaultTab, children }: ContainerProps) {
  // SSR: trust the defaultTab. Client first paint: sync to the URL
  // hash BEFORE the user sees the wrong panel. The hydration mismatch
  // from this is acceptable - hidden-panel content is identical SSR
  // vs CSR; only the `display` style on each wrapper differs by one
  // render.
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
        aria-label="Sections"
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
 * Filter wrapper: hides every `<SectionTabPanel>` child whose `id`
 * doesn't match `activeId`. Non-panel children (no marker attribute)
 * pass through verbatim - useful for banners that should show on
 * every tab.
 */
function ActivePanelGate({ activeId, children }: { activeId: string; children: ReactNode }) {
  return (
    <>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const props = child.props as Record<string, unknown>;
        const marker = props["data-section-tab"];
        if (typeof marker !== "string") return child;
        const display = marker === activeId ? undefined : "none";
        return (
          <div key={marker} style={{ display }}>
            {child as ReactElement}
          </div>
        );
      })}
    </>
  );
}

/**
 * Wrapper that marks its children as belonging to a specific tab.
 * Server-renderable. The `data-section-tab` attribute is what the
 * gate reads at runtime; the DOM `id` stays for screen-reader and
 * anchor-link interop.
 */
export function SectionTabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} data-section-tab={id} className="scroll-mt-20">
      {children}
    </section>
  );
}
