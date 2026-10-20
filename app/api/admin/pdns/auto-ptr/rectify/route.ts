/**
 * app/api/admin/pdns/auto-ptr/rectify/route.ts
 *
 * POST - write or remove PTRs chosen on the Reverse DNS page. Each item is
 * turned into the forward change the record editor would have produced and
 * handed to the same auto-PTR orchestrator, so the permission check (records
 * in the reverse zone), the "never clobber a PTR that points elsewhere unless
 * asked" rule, the audit rows and the NOTIFY are identical to a save. A `set`
 * item carries takeover, because the operator picked the name on a page that
 * showed them what the PTR currently says; a `remove` item only removes a PTR
 * that still points at the given target.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { requireCsrf } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/require-user";
import { getRequestContext } from "@/lib/client-ip";
import { findDefaultPdnsServer, listActivePdnsServers } from "@/lib/db/repositories/pdns-servers";
import { parseIp } from "@/lib/dns/reverse-name";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { ttlSchema } from "@/lib/validators/common";
import { validateHostname } from "@/lib/validators/rr-types/hostname";
import { runAutoPtr, type AutoPtrChange } from "../../zones/[zoneId]/rrsets/_auto-ptr";
import { invalidateFleetScan } from "../_scan";

const itemSchema = z.object({
  ip: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => parseIp(v) !== null, "Not an IP address."),
  action: z.enum(["set", "remove"]),
  target: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !validateHostname(v).issues.some((i) => i.level === "error"), "Not a hostname."),
  ttl: ttlSchema.optional(),
});

const bodySchema = z.object({
  items: z.array(itemSchema).min(1).max(500),
});

const canonicalName = (name: string): string => {
  const trimmed = name.trim().toLowerCase();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
};

export async function POST(request: Request): Promise<Response> {
  try {
    const { user, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);
    let input;
    try {
      input = bodySchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      }
      throw err;
    }

    // The orchestrator wants a "forward" backend only to prefer it as the
    // reverse zone's host; the page spans the fleet, so the default one will do.
    const forwardServer = (await findDefaultPdnsServer()) ?? (await listActivePdnsServers())[0];
    if (!forwardServer) throw new ValidationError("No active PowerDNS backend.");

    const changes: AutoPtrChange[] = input.items.map((item) => {
      const family = parseIp(item.ip)!.family;
      const type = family === 4 ? "A" : "AAAA";
      const name = canonicalName(item.target);
      return item.action === "set"
        ? {
            change: {
              kind: "upsert",
              name,
              type,
              ttl: item.ttl ?? 3600,
              records: [{ content: item.ip }],
            },
            before: null,
            takeover: true,
          }
        : {
            change: { kind: "delete", name, type },
            before: { ttl: 0, records: [{ content: item.ip }] },
            takeover: false,
          };
    });

    const outcomes = await runAutoPtr({
      forwardServer,
      forwardZone: "",
      changes,
      canOnZone: (serverId, zone, permission) =>
        canActOnZone({
          hasGlobalPermission: globalPermissions.has(permission),
          grants: zoneGrants,
          serverId,
          zoneName: zone,
          permission,
        }),
      dryRun: false,
      actor: { type: "user", id: user.id },
      request: getRequestContext(await headers()),
      summaryMode: "reverse",
    });
    invalidateFleetScan();
    return Response.json({ outcomes });
  } catch (err) {
    return errorResponse(err, "auto-ptr.rectify.error");
  }
}
