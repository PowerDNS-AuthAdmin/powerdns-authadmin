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

export async function loadNotificationsFor(auth: AuthenticatedRequest): Promise<AppNotification[]> {
  const viewer = notificationViewerFor(auth);
  // A user with neither audience sees nothing; skip the query entirely.
  if (!viewer.canReadServers && !auth.ability.can("read", "Zone")) return [];
  return visibleNotifications(await listActiveAdvisories(), viewer);
}
