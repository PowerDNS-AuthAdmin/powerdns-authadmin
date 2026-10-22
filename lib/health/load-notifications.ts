/**
 * lib/health/load-notifications.ts
 *
 * Loads the notifications one authenticated user may see. The bell, the
 * Notifications page, the JSON route and the dismiss route all go through
 * here so the per-row visibility rule (lib/health/notifications.ts) has a
 * single entry point.
 */

import "server-only";
import type { AuthenticatedRequest } from "@/lib/auth/get-current-user";
import { listActiveAdvisories } from "@/lib/db/repositories/backend-advisories";
import { canActOnZone, holdsOnSomeZone } from "@/lib/rbac/zone-permissions";
import {
  visibleNotifications,
  type AppNotification,
  type NotificationViewer,
} from "@/lib/health/notifications";

/**
 * Backend health rows are not per-backend filtered, so they follow the
 * Servers page guard: a GLOBAL `server.read`. A type-level
 * `ability.can("read", "Server")` would also be true for a role scoped to one
 * server and show it every backend's advisories. Monitoring rows go through
 * `canActOnZone`, so a zone grant or a role scoped to the zone (ADR-0024)
 * sees that zone's findings and no other.
 */
export function notificationViewerFor(
  auth: Pick<AuthenticatedRequest, "globalPermissions" | "zoneGrants" | "zoneScopedPermissions">,
): NotificationViewer {
  return {
    canReadServers: auth.globalPermissions.has("server.read"),
    globalZoneRead: auth.globalPermissions.has("zone.read"),
    canReadZone: (serverId, zone) =>
      canActOnZone(auth, { serverId, zoneName: zone, permission: "zone.read" }),
  };
}

/**
 * Could this user see any notification at all? Backend readers, global zone
 * readers, and users holding `zone.read` on some zone through a grant or a
 * zone-scoped role - the users per-row filtering exists for.
 */
export function hasNotificationAudience(
  auth: Pick<AuthenticatedRequest, "globalPermissions" | "zoneGrants" | "zoneScopedPermissions">,
): boolean {
  return (
    auth.globalPermissions.has("server.read") ||
    auth.globalPermissions.has("zone.read") ||
    holdsOnSomeZone(auth, (p) => p === "zone.read")
  );
}

export async function loadNotificationsFor(auth: AuthenticatedRequest): Promise<AppNotification[]> {
  // A user with no audience sees nothing; skip the query entirely.
  if (!hasNotificationAudience(auth)) return [];
  const viewer = notificationViewerFor(auth);
  return visibleNotifications(await listActiveAdvisories(), viewer);
}
