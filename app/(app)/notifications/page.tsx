/**
 * app/(app)/notifications/page.tsx
 *
 * Every notification this user may see: backend health and zone monitoring,
 * active and dismissed. The header bell previews the top few and links here.
 * The list is filtered per row on the server (lib/health/notifications.ts),
 * so a user granted a handful of zones sees only those zones' findings.
 */

import type { Metadata } from "next";
import { Bell } from "lucide-react";
import { requireUserForPage } from "@/lib/auth/require-user";
import { loadNotificationsFor } from "@/lib/health/load-notifications";
import { NotificationsList } from "./_components/notifications-list";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const current = await requireUserForPage();
  const notifications = await loadNotificationsFor(current);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bell aria-hidden className="h-6 w-6 text-[color:var(--color-fg-muted)]" />
          Notifications
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Backend health and zone monitoring findings. Dismissing hides a notification until its
          condition changes or comes back.
        </p>
      </header>
      <NotificationsList notifications={notifications} />
    </div>
  );
}
