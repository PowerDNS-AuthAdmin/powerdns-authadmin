/**
 * lib/rbac/zone-grant-permissions.ts
 *
 * The subset of the master permission vocabulary that makes sense as
 * a per-zone grant - i.e. permissions whose action targets a specific
 * zone. User/team/role/server administration is deliberately omitted:
 * a per-zone grant scope can't gate those, and showing them in the
 * grant-permission picker would confuse operators.
 *
 * Lifted out of the user-detail page so the team-detail page and any
 * future grant surface share the same list.
 */

import { PERMISSIONS } from "./permissions";

export const ZONE_GRANT_PERMISSIONS: readonly string[] = PERMISSIONS.filter((p) =>
  /^(zone|record|dnssec|metadata|tsig)\./.test(p),
);
