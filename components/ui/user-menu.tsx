"use client";

/**
 * components/ui/user-menu.tsx
 *
 * Top-right avatar dropdown. Shows the signed-in user's name + email and
 * exposes Sign out (and, later, "Profile" / "API tokens" links).
 *
 * Implementation notes:
 *   - Hand-rolled popover with click-outside + Escape-to-close. future work will
 *     swap in shadcn/Radix primitives across the UI; this component is a
 *     placeholder that's behaviorally complete (focus management aside) and
 *     will be migrated then.
 *   - The "avatar" is an SVG-generated monogram derived from email. No
 *     Gravatar — CONTRIBUTING.md bans external image hosts.
 */

import { useEffect, useRef, useState } from "react";
import { LogOut, User as UserIcon } from "lucide-react";
import { apiFetch } from "@/lib/client/api-fetch";

interface UserMenuProps {
  email: string;
  name: string | null;
}

export function UserMenu({ email, name }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on Escape and on click outside the container. One effect handles
  // both; both event types remove themselves on cleanup.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const display = name ?? email;
  const initial = (name?.[0] ?? email[0] ?? "?").toUpperCase();

  // Sign-out is a state-changing POST. `apiFetch` adds the CSRF header
  // so `requireCsrf` on /api/auth/logout accepts it. The server replies
  // with JSON `{ ok, location }` — `location` is either the IdP's
  // RP-initiated-logout URL (for OIDC sessions) or the local
  // /login?signed-out=1 fallback. We navigate via `window.location.replace`
  // rather than letting fetch follow a 303 redirect: a cross-origin
  // redirect to the IdP's domain would be blocked by our
  // `connect-src 'self'` CSP, but a top-level navigation is exempt.
  //
  // This is the same flow certifi uses (see certifi/web/src/auth.tsx).
  async function signOut() {
    let target = "/login?signed-out=1";
    try {
      const res = await apiFetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { location?: string } | null;
        if (data && typeof data.location === "string" && data.location.length > 0) {
          target = data.location;
        }
      }
    } catch {
      // Network failure — fall through to the local redirect.
    }
    window.location.replace(target);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-sm hover:bg-[color:var(--color-bg-subtle)]"
      >
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--color-accent)] text-xs font-medium text-[color:var(--color-accent-fg)]"
        >
          {initial}
        </span>
        <span className="hidden max-w-[16ch] truncate sm:inline">{display}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 origin-top-right rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] shadow-lg"
        >
          <div className="border-b border-[color:var(--color-border)] px-3 py-2 text-xs">
            <div className="font-medium text-[color:var(--color-fg)]">{name ?? "Signed in"}</div>
            <div className="truncate text-[color:var(--color-fg-muted)]" title={email}>
              {email}
            </div>
          </div>
          <div className="py-1">
            <MenuLink href="/profile" icon={<UserIcon className="h-4 w-4" />}>
              Profile
            </MenuLink>
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-subtle)]"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuLink({
  href,
  icon,
  children,
  disabled,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled
        className="flex cursor-not-allowed items-center gap-2 px-3 py-2 text-sm text-[color:var(--color-fg-subtle)]"
      >
        {icon}
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      role="menuitem"
      className="flex items-center gap-2 px-3 py-2 text-sm text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-subtle)]"
    >
      {icon}
      {children}
    </a>
  );
}
