"use client";

/**
 * components/ui/theme-toggle.tsx
 *
 * Light / dark / system theme switch. One button - the icon mirrors the active
 * preference (Sun / Moon / Monitor) and clicking cycles light → dark → system →
 * light. Same persistence + live-listener behaviour as before; only the chrome
 * collapsed from three buttons to one.
 *
 * Behavior:
 *   - Default is "system" (follows the OS / browser preference).
 *   - User choice is persisted to localStorage under `pda-theme`.
 *   - The actual `.dark` class on <html> is applied by the inline
 *     `theme-init` script in `app/layout.tsx` BEFORE React hydrates -
 *     this prevents a flash-of-wrong-theme on page load.
 *   - This component just updates the preference + the live class and
 *     listens for OS-level changes when in "system" mode.
 */

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "pda-theme";
const CYCLE: readonly Theme[] = ["light", "dark", "system"];

const ICON_BY_THEME: Record<Theme, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const LABEL_BY_THEME: Record<Theme, string> = {
  light: "light",
  dark: "dark",
  system: "system",
};

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

  function cycle(): void {
    const idx = CYCLE.indexOf(theme);
    const next = CYCLE[(idx + 1) % CYCLE.length] ?? "system";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyEffective(resolveEffective(next));
  }

  const Icon = ICON_BY_THEME[theme];
  const nextTheme = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length] ?? "system";
  const tooltip = `Theme: ${LABEL_BY_THEME[theme]} (click for ${LABEL_BY_THEME[nextTheme]})`;

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={tooltip}
      title={tooltip}
      className={[
        "flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[color:var(--color-fg-muted)] transition-colors hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)]",
        className,
      ].join(" ")}
    >
      <Icon aria-hidden className="h-4 w-4" />
    </button>
  );
}
