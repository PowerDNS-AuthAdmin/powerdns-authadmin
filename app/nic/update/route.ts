/**
 * app/nic/update/route.ts
 *
 * GET /nic/update — DynDNS 2 endpoint (https://help.dyn.com/remote-access-api/perform-update/).
 * Operators bringing over a DynDNS setup use this with `ddclient` or
 * router firmware; the contract is fixed text strings (see
 * `lib/dyndns/parse.ts` for the vocab).
 *
 * Authentication: HTTP Basic with `user:token` where:
 *   - `user` is the operator's account email,
 *   - `token` is one of their PATs (`pda_pat_<...>`).
 * The token must have `record.update` permission scoped to the zone
 * the hostname falls under.
 *
 * Resolution: the route calls PDNS' `listZones` once and picks the
 * longest matching zone for the hostname. ddclient sends one update
 * per polling interval (~5 min default), so the per-call cost is
 * acceptable. Caching the zone list is a future optimization if
 * scrape rates become a concern.
 *
 * Response: always 200 with `text/plain` body. DynDNS clients parse
 * the body, not the HTTP status. Errors that look like HTTP errors
 * (auth failures, server errors) still return 200; the status code
 * encoded in the body is what counts for ddclient and friends.
 */

import {
  findApiTokenByPublicPrefix,
  touchApiTokenLastUsed,
} from "@/lib/db/repositories/api-tokens";
import { findUserByEmail } from "@/lib/db/repositories/users";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { listGrantsForUser } from "@/lib/db/repositories/zone-grants";
import { listActivePdnsServers } from "@/lib/db/repositories/pdns-servers";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestContext } from "@/lib/client-ip";
import {
  findLongestZoneMatch,
  formatResponse,
  parseBasicAuth,
  parseDynDnsRequest,
  type DynDnsCode,
} from "@/lib/dyndns/parse";
import { headers } from "next/headers";
import { parsePresentedToken, verifyTokenAgainstHash } from "@/lib/auth/tokens";
import {
  narrowAssignmentsByTokenScopes,
  type NarrowableAssignment,
} from "@/lib/auth/token-scope-narrowing";
import { globalPermissionsOf } from "@/lib/rbac/ability";
import { hasZonePermissionViaGrant } from "@/lib/rbac/zone-permissions";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { replaceRRset, zonePatchBody } from "@/lib/pdns/rrsets";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { PdnsError } from "@/lib/pdns/errors";

function plain(code: DynDnsCode, ip?: string): Response {
  return new Response(formatResponse(code, ip), {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function plainWithChallenge(code: DynDnsCode): Response {
  // For `badauth` we attach a Basic challenge — some clients (ddclient
  // especially) re-prompt for credentials on first auth failure when
  // the server volunteers a realm.
  return new Response(formatResponse(code), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="DynDNS"',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const hdrs = await headers();
  const parsed = parseDynDnsRequest(new URL(request.url));
  if (parsed.kind === "error") {
    return plain(parsed.code);
  }
  const { hostname, myip } = parsed.req;

  // ── Auth ────────────────────────────────────────────────────────────────
  const basic = parseBasicAuth(request.headers.get("authorization"));
  if (!basic) return plainWithChallenge("badauth");

  const user = await findUserByEmail(basic.user);
  if (!user || user.disabledAt) {
    // Don't distinguish missing-user from disabled — both map to badauth.
    return plainWithChallenge("badauth");
  }

  const parsedTok = parsePresentedToken(basic.pass);
  if (!parsedTok) return plainWithChallenge("badauth");

  const tokenRow = await findApiTokenByPublicPrefix(parsedTok.prefix);
  if (!tokenRow) return plainWithChallenge("badauth");
  if (tokenRow.userId !== user.id) return plainWithChallenge("badauth");
  if (tokenRow.revokedAt) return plainWithChallenge("badauth");
  if (tokenRow.expiresAt && tokenRow.expiresAt.getTime() <= Date.now()) {
    return plainWithChallenge("badauth");
  }
  const matched = await verifyTokenAgainstHash(basic.pass, tokenRow.tokenHash);
  if (!matched) return plainWithChallenge("badauth");

  // Narrow assignments + zone grants to the token's stored scopes, then
  // derive the user's global permissions. The DynDNS update needs
  // `record.update` — held either at GLOBAL scope OR via a zone_grant for
  // the specific zone the hostname falls under (checked per-zone below).
  const rawAssignments = await loadUserAssignmentsForAbility(user.id);
  const narrowed = narrowAssignmentsByTokenScopes(
    rawAssignments as readonly NarrowableAssignment[],
    tokenRow.scopes,
  );
  const globalPermissions = globalPermissionsOf(narrowed);
  const rawGrants = await listGrantsForUser(user.id);
  const zoneGrants =
    tokenRow.scopes.length === 0
      ? rawGrants
      : rawGrants
          .map((g) => ({
            ...g,
            permissions: g.permissions.filter((p) => tokenRow.scopes.includes(p)),
          }))
          .filter((g) => g.permissions.length > 0);

  // ── Source IP — use the explicit param when given, else derive ──────────
  const sourceIp = myip ?? getClientIp(hdrs);
  if (!sourceIp) {
    // The client didn't supply `myip` and we don't trust XFF — there's
    // nothing safe to write. dnserr is the closest DynDNS code for
    // "server can't fulfill the request right now."
    return plain("dnserr");
  }

  // ── Zone resolution: scan every active backend, find the longest match
  const servers = await listActivePdnsServers();
  for (const server of servers) {
    const client = getBackendGateway(server);
    let zoneList;
    try {
      zoneList = await client.listZones();
    } catch (err) {
      logger.warn(
        { server: server.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
        "dyndns.listZones.failed",
      );
      continue;
    }
    // PDNS zone names carry a trailing dot; we work without it.
    const zoneNames = zoneList.map((z) => z.name.replace(/\.$/, "").toLowerCase());
    const zoneNameNoDot = findLongestZoneMatch(hostname, zoneNames);
    if (!zoneNameNoDot) continue;
    const zoneName = `${zoneNameNoDot}.`;

    // record.update held at GLOBAL scope OR via a zone_grant for THIS
    // (server, zone). A type-level CASL check would let a token with any
    // scoped record.update rewrite every zone — see
    // lib/rbac/ability.ts:globalPermissionsOf.
    const allowed =
      globalPermissions.has("record.update") ||
      hasZonePermissionViaGrant(zoneGrants, server.id, zoneName, "record.update");
    if (!allowed) {
      return plain("nohost");
    }

    const rrType = isIpv6(sourceIp) ? "AAAA" : "A";
    const patch = replaceRRset({
      name: `${hostname}.`,
      type: rrType,
      ttl: 300,
      records: [{ content: sourceIp }],
    });

    try {
      await client.patchZone(zoneName, zonePatchBody(patch));
    } catch (err) {
      if (err instanceof PdnsError) {
        logger.warn(
          { server: server.slug, zone: zoneName, err: redact(err.message) },
          "dyndns.patch.failed",
        );
        return plain("dnserr");
      }
      throw err;
    }

    void touchApiTokenLastUsed(tokenRow.id, getClientIp(hdrs)).catch(() => undefined);

    // Audit the update via the existing record.update vocabulary; the
    // resource carries the zone so the change-log viewer surfaces it.
    await appendAudit({
      actor: { type: "token", id: tokenRow.id },
      action: "record.update",
      resource: { type: "zone", id: zoneName },
      after: {
        source: "dyndns",
        hostname: `${hostname}.`,
        rrType,
        value: sourceIp,
      },
      request: getRequestContext(hdrs),
    });

    return plain("good", sourceIp);
  }

  // No backend had a zone that matches → either the operator never
  // created the zone, or it lives on a backend we couldn't reach.
  return plain("nohost");
}

function isIpv6(s: string): boolean {
  return s.includes(":");
}
