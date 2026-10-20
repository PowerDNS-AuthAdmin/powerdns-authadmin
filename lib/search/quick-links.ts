/**
 * lib/search/quick-links.ts
 *
 * What the search palette offers before anything is typed: the zone pages and
 * the admin pages this user can open. Each entry carries the same check its
 * page applies (`requireUserForPage({ can })`, type-level for the pages that
 * accept a scoped grant), so the palette never offers a link that bounces.
 */

import "server-only";
import type { AuthenticatedRequest } from "@/lib/auth/get-current-user";
import type { SearchFeatures } from "./index";
import type { SearchQuickLink, SearchTabVisibility } from "./types";
import { searchTabVisibility } from "./index";

type Actor = Pick<AuthenticatedRequest, "ability" | "globalPermissions" | "zoneGrants">;

/** Empty-state shortcuts for this user, zone pages first. */
export function buildSearchQuickLinks(actor: Actor, features: SearchFeatures): SearchQuickLink[] {
  const { ability, globalPermissions: g } = actor;
  const candidates: Array<SearchQuickLink & { allowed: boolean }> = [
    {
      label: "Zones",
      href: "/zones",
      hint: "Every zone you can read",
      allowed: ability.can("read", "Zone") || actor.zoneGrants.length > 0,
    },
    {
      label: "Add record",
      href: "/zones/new-record",
      hint: "Pick a zone, then the record",
      allowed: ability.can("create", "Record"),
    },
    {
      label: "Reverse DNS",
      href: "/zones/auto-ptr",
      hint: "Addresses against their PTRs",
      allowed: features.reverseDns && g.has("record.read"),
    },
    {
      label: "Zone Monitoring",
      href: "/zones/monitoring",
      hint: "Delegation and DNSSEC findings",
      allowed: features.zoneMonitoring && g.has("zone.read"),
    },
    { label: "Servers", href: "/admin/servers", allowed: g.has("server.read") },
    { label: "Users", href: "/admin/users", allowed: g.has("user.read") },
    { label: "Teams", href: "/admin/teams", allowed: ability.can("read", "Team") },
    { label: "Roles", href: "/admin/roles", allowed: g.has("role.read") },
    { label: "Authentication", href: "/admin/authentication", allowed: g.has("auth.read") },
    { label: "TSIG keys", href: "/admin/tsig-keys", allowed: g.has("tsig.read") },
    { label: "Zone templates", href: "/admin/zone-templates", allowed: g.has("template.use") },
    { label: "Settings", href: "/admin/settings", allowed: g.has("settings.read") },
    { label: "Audit log", href: "/admin/audit", allowed: g.has("audit.read") },
    { label: "Request log", href: "/admin/requests", allowed: g.has("audit.read") },
  ];
  return candidates.filter((c) => c.allowed).map(({ allowed: _allowed, ...link }) => link);
}

/** Tab visibility for the palette, from the authenticated request. */
export function searchTabsFor(actor: Actor): SearchTabVisibility {
  return searchTabVisibility({
    globalPermissions: actor.globalPermissions,
    zoneGrants: actor.zoneGrants,
    canReadTeam: (id) => actor.ability.can("read", { __type: "Team", id }),
  });
}
