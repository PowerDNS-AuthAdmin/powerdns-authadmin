"use client";

/**
 * components/ui/theme-toggle.tsx
 *
 * Three-way light / dark / system theme switch.
 *
 * Behavior:
 *   - Default is "system" (follows the OS / browser preference).
 *   - User choice is persisted to localStorage under `pda-theme`.
 *   - The actual `.dark` class on <html> is applied by the inline
 *     `theme-init` script in `app/layout.tsx` BEFORE React hydrates —
 *     this prevents a flash-of-wrong-theme on page load.
 *   - This component just updates the preference + the live class and
 *     listens for OS-level changes when in "system" mode.
 *
 * No external icon CDN — Lucide ships SVGs as React components, fully
 * self-hosted per CONTRIBUTING.md.
 */

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "pda-theme";

/** Resolve a user preference to the *effective* theme (light or dark). */
function resolveEffective(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

/** Apply the effective theme by toggling the `.dark` class on <html>. */
function applyEffective(effective: "light" | "dark"): void {
  document.documentElement.classList.toggle("dark", effective === "dark");
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  // We avoid SSR mismatch by reading the user choice only after mount.
  // The pre-hydration script in app/layout.tsx applies the class first,
  // so the visual theme is correct before this component renders.
  const [theme, setTheme] = useState<Theme>("system");

  // Read the stored choice on mount.
  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
    setTheme(stored);
  }, []);

  // When in "system" mode, react to OS-level theme changes live.
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyEffective(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  function choose(next: Theme): void {
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyEffective(resolveEffective(next));
  }

  // Render: three icon buttons. The active one is highlighted via aria-pressed.
  return (
    <div
      role="group"
      aria-label="Theme"
      className={`inline-flex items-center gap-0.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-0.5 ${className}`}
    >
      <ToggleButton label="Light" pressed={theme === "light"} onClick={() => choose("light")}>
        <Sun aria-hidden className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton label="System" pressed={theme === "system"} onClick={() => choose("system")}>
        <Monitor aria-hidden className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton label="Dark" pressed={theme === "dark"} onClick={() => choose("dark")}>
        <Moon aria-hidden className="h-4 w-4" />
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      className={[
        "flex h-7 w-7 items-center justify-center rounded transition-colors",
        pressed
          ? "bg-[color:var(--color-bg-muted)] text-[color:var(--color-fg)]"
          : "text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
