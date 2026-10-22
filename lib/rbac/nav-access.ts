/**
 * lib/rbac/nav-access.ts
 *
 * Which navigation entries the app shell offers. Each flag mirrors the guard
 * of the page it links to, so a menu item is shown exactly when clicking it
 * would be admitted. The shell used type-level `ability.can(action, "Type")`
 * checks, which are true for ANY scoped rule - a user whose only role was
 * scoped to one zone was offered Servers, Users, Audit, … and every click
 * bounced off the page's global-only guard.
 *
 * Pure so the predicates can be unit-tested; the layout feeds it the
 * request's `AuthenticatedRequest`.
 */

import { canListZones, canUseRecordWizard, type ZoneAccess } from "./zone-permissions";

export interface NavAccessInput extends ZoneAccess {
  /**
   * Type-level `ability.can("read", "Team")`. The Teams list is the one page
   * that admits a scoped grant (`requireUserForPage({ anyInstance: true })`)
   * and filters rows per team, so its entry follows the same check.
   */
  canReadAnyTeam: boolean;
  /**
   * The opt-in pages (`REVERSE_DNS_ENABLED`, `ZONE_MONITOR_ENABLED`) answer
   * 404 while their feature is off, so their entries disappear with them.
   */
  features: { reverseDns: boolean; zoneMonitoring: boolean };
}

export interface NavAccess {
  zones: boolean;
  reverseDns: boolean;
  zoneMonitoring: boolean;
  /** The Add record wizard (`/zones/new-record`). */
  addRecord: boolean;
  servers: boolean;
  autoprimaries: boolean;
  zoneTemplates: boolean;
  importExport: boolean;
  tsigKeys: boolean;
  requestLog: boolean;
  changeLog: boolean;
  users: boolean;
  teams: boolean;
  roles: boolean;
  authentication: boolean;
  audit: boolean;
  settings: boolean;
}

/**
 * Every page below guards with `requireUserForPage({ can })` and no `on`,
 * which admits only a GLOBAL grant - so the nav checks the global set too.
 * The exceptions are Zones, whose page admits grants and zone-scoped roles
 * through `canListZones`, and Add record, which any zone the user may create
 * records in opens (the wizard only offers those zones). Reverse DNS and Zone
 * Monitoring list every zone of the fleet, so they stay global.
 */
export function navAccessOf(input: NavAccessInput): NavAccess {
  const global = (p: string) => input.globalPermissions.has(p);
  return {
    zones: canListZones(input),
    reverseDns: input.features.reverseDns && global("record.read"),
    zoneMonitoring: input.features.zoneMonitoring && global("zone.read"),
    addRecord: canUseRecordWizard(input),
    servers: global("server.read"),
    autoprimaries: global("autoprimary.manage"),
    zoneTemplates: global("template.use"),
    importExport: global("zone.read"),
    tsigKeys: global("tsig.read"),
    requestLog: global("audit.read"),
    changeLog: global("audit.read"),
    users: global("user.read"),
    teams: input.canReadAnyTeam,
    roles: global("role.read"),
    authentication: global("auth.read"),
    audit: global("audit.read"),
    settings: global("settings.read"),
  };
}
