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
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import {
  visibleNotifications,
  type AppNotification,
  type NotificationViewer,
} from "@/lib/health/notifications";

export function notificationViewerFor(auth: AuthenticatedRequest): NotificationViewer {
  const globalZoneRead = auth.globalPermissions.has("zone.read");
  return {
    canReadServers: auth.ability.can("read", "Server"),
    globalZoneRead,
    canReadZone: (serverId, zone) =>
      canActOnZone({
        hasGlobalPermission: globalZoneRead,
        grants: auth.zoneGrants,
        serverId,
        zoneName: zone,
        permission: "zone.read",
      }),
  };
}

/**
 * Could this user see any notification at all? Backend readers, zone readers,
 * and users whose only zone access is a zone grant: grants are not part of
 * the CASL ability, so `ability.can("read", "Zone")` alone would hide the
 * bell from exactly the users per-row filtering exists for.
 */
export function hasNotificationAudience(auth: AuthenticatedRequest): boolean {
  return (
    auth.ability.can("read", "Server") ||
    auth.ability.can("read", "Zone") ||
    auth.zoneGrants.some((g) => g.permissions.includes("zone.read"))
  );
}

export async function loadNotificationsFor(auth: AuthenticatedRequest): Promise<AppNotification[]> {
  // A user with no audience sees nothing; skip the query entirely.
  if (!hasNotificationAudience(auth)) return [];
  const viewer = notificationViewerFor(auth);
  return visibleNotifications(await listActiveAdvisories(), viewer);
}
