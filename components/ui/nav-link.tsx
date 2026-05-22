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
}

export function NavLink({ href, label }: NavLinkProps) {
  const pathname = usePathname();
  const active = isActive(pathname, href);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "block rounded-md bg-[color:var(--color-bg-muted)] px-3 py-2 font-medium text-[color:var(--color-fg)]"
          : "block rounded-md px-3 py-2 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-muted)] hover:text-[color:var(--color-fg)]"
      }
    >
      {label}
    </Link>
  );
}

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard") return pathname === "/dashboard";
  // Match the href itself or any deeper segment (`/admin/users/123`).
  return pathname === href || pathname.startsWith(`${href}/`);
}
