"use client";

/**
 * components/ui/user-menu.tsx
 *
 * Top-right avatar dropdown. Shows the signed-in user's name + email and
 * exposes Profile and Sign out.
 *
 * Implementation notes:
 *   - Hand-rolled `role="menu"` popover following the WAI-ARIA menu button
 *     pattern: the trigger opens it, focus moves to the first item, ↑/↓
 *     wrap between items, Home/End jump, Escape closes and returns focus to
 *     the trigger, Tab or a click outside closes it. Items use a roving
 *     `tabIndex={-1}` so the menu is one Tab stop, not one per item.
 *   - The "avatar" is an SVG-generated monogram derived from email. No
 *     Gravatar - CONTRIBUTING.md bans external image hosts.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LogOut, User as UserIcon } from "lucide-react";
import { apiFetch } from "@/lib/client/api-fetch";

interface UserMenuProps {
  email: string;
  name: string | null;
}

export function UserMenu({ email, name }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside the container. Escape is handled on the menu
  // itself (below) so it can also hand focus back to the trigger.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Focus the first item as soon as the menu is in the DOM.
  useEffect(() => {
    if (open) menuItems()[0]?.focus();
  }, [open]);

  function menuItems(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
  }

  function closeAndRefocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        items[(current + 1) % items.length]?.focus();
        return;
      case "ArrowUp":
        e.preventDefault();
        items[(current - 1 + items.length) % items.length]?.focus();
        return;
      case "Home":
        e.preventDefault();
        items[0]?.focus();
        return;
      case "End":
        e.preventDefault();
        items[items.length - 1]?.focus();
        return;
      case "Escape":
        e.preventDefault();
        closeAndRefocus();
        return;
      case "Tab":
        // Let the browser move on, but don't leave an open menu behind.
        setOpen(false);
        return;
    }
  }

  const display = name ?? email;
  const initial = (name?.[0] ?? email[0] ?? "?").toUpperCase();

  // Sign-out is a state-changing POST. `apiFetch` adds the CSRF header
  // so `requireCsrf` on /api/auth/logout accepts it. The server replies
  // with JSON `{ ok, location }` - `location` is either the IdP's
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
      // Network failure - fall through to the local redirect.
    }
    window.location.replace(target);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // ↓ on a closed menu button opens it (and the effect focuses item 1).
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${display}`}
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
          ref={menuRef}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-50 mt-2 w-56 origin-top-right rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] shadow-lg"
        >
          <div className="border-b border-[color:var(--color-border)] px-3 py-2 text-xs">
            <div className="font-medium text-[color:var(--color-fg)]">{name ?? "Signed in"}</div>
            <div className="truncate text-[color:var(--color-fg-muted)]" title={email}>
              {email}
            </div>
          </div>
          <div className="py-1">
            <MenuLink href="/profile" icon={<UserIcon className="h-4 w-4" aria-hidden />}>
              Profile
            </MenuLink>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={signOut}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-subtle)] focus-visible:bg-[color:var(--color-bg-subtle)]"
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
        role="menuitem"
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
      tabIndex={-1}
      className="flex items-center gap-2 px-3 py-2 text-sm text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-subtle)] focus-visible:bg-[color:var(--color-bg-subtle)]"
    >
      {icon}
      {children}
    </a>
  );
}
