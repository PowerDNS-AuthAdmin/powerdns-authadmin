"use client";

/**
 * components/ui/nav-link.tsx
 *
 * Sidebar link that highlights itself when the current pathname matches.
 *
 * "Match" rules:
 *   - `/dashboard` matches only `/dashboard` (exact).
 *   - Everything else matches its own path and any deeper segment, so
 *     `/admin/users` stays active on `/admin/users/<id>` and
 *     `/admin/users/new`.
 *
 * Client component because it needs `usePathname()`. The parent layout
 * stays a server component and passes the link's href down as a prop.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavLinkProps {
  href: string;
  label: string;
  /** When true, render as a child of a nav section: indented with a leading
   *  marker so the parent→child relationship reads at a glance. */
  nested?: boolean;
  /**
   * Number of things needing attention behind this link (0 or undefined hides
   * the badge). `badgeTone` picks error (red) or warn (amber).
   */
  badge?: number;
  badgeTone?: "error" | "warn";
  /** Spoken alternative for the badge, e.g. "3 zones with problems". */
  badgeLabel?: string;
}

export function NavLink({
  href,
  label,
  nested = false,
  badge,
  badgeTone = "warn",
  badgeLabel,
}: NavLinkProps) {
  const pathname = usePathname();
  const active = isActive(pathname, href);

  // Nested (section) links sit further left-padded than top-level items so
  // they read as children of their section header.
  const pad = nested ? "py-2 pr-3 pl-4" : "px-3 py-2";
  const tone = active
    ? "bg-[color:var(--color-bg-muted)] font-medium text-[color:var(--color-fg)]"
    : "text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-muted)] hover:text-[color:var(--color-fg)]";

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between gap-2 rounded-md ${pad} ${tone}`}
    >
      <span>{label}</span>
      {badge ? (
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
            badgeTone === "error"
              ? "border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 text-[color:var(--color-error-fg)]"
              : "border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn-fg)]"
          }`}
          aria-label={badgeLabel ?? `${badge} needing attention`}
          title={badgeLabel ?? `${badge} needing attention`}
        >
          {badge > 999 ? "999+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard") return pathname === "/dashboard";
  // Match the href itself or any deeper segment (`/admin/users/123`).
  return pathname === href || pathname.startsWith(`${href}/`);
}
