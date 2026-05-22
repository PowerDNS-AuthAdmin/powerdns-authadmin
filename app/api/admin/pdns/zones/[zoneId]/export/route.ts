/**
 * app/api/admin/pdns/zones/[zoneId]/export/route.ts
 *
 * GET — render the zone's current rrsets as a BIND zonefile and stream
 *       it back as `<zone>.zone`. Used by the web UI to force a backup
 *       download before the operator can confirm a zone delete; equally
 *       useful as a "give me this zone in BIND format" endpoint.
 *
 * Permission: `zone.read` (same as the read-only zone view).
 */

import { z, ZodError } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { PdnsError, PdnsNotFoundError } from "@/lib/pdns/errors";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

const queryShape = z.object({
  serverSlug: z.string().optional(),
});

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { globalPermissions, zoneGrants } = await requireUser();
    const { zoneId } = await context.params;
    const url = new URL(request.url);
    let parsed;
    try {
      parsed = queryShape.parse(Object.fromEntries(url.searchParams));
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const selected = parsed.serverSlug
      ? await findPdnsServerBySlug(parsed.serverSlug)
      : await findDefaultPdnsServer();
    if (selected?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }

    const zoneName = decodeURIComponent(zoneId);

    if (
      !canActOnZone({
        hasGlobalPermission: globalPermissions.has("zone.read"),
        grants: zoneGrants,
        serverId: selected.id,
        zoneName,
        permission: "zone.read",
      })
    ) {
      throw new ForbiddenError("Missing zone.read for this zone.");
    }

    const client = getPdnsClientForRow(selected);
    let zone;
    try {
      zone = await client.getZone(zoneName);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) {
        throw new NotFoundError("Zone not found on backend.");
      }
      if (err instanceof PdnsError) {
        const message = redact(err.message);
        logger.warn({ err: message }, "pdns.zone.export.failed");
        return Response.json({ error: `PDNS rejected the request: ${message}` }, { status: 502 });
      }
      throw err;
    }

    const body = renderZonefile(zone.rrsets ?? []);
    const filename = bindFileName(zone.name);

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return Response.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof NotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ValidationError) {
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    }
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "pdns.zone.export.route.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}

/**
 * Tab-separated BIND zonefile, sorted by name then type. The leading
 * `$ORIGIN .` line tells BIND parsers that every name in the file is
 * already fully-qualified (relative names would need `$ORIGIN <zone>.`
 * instead). Output is deterministic so two exports of an unchanged zone
 * are byte-identical.
 */
function renderZonefile(
  rrsets: Array<{
    name: string;
    type: string;
    ttl: number;
    records: Array<{ content: string; disabled?: boolean }>;
  }>,
): string {
  const sorted = [...rrsets].sort((a, b) => {
    const n = a.name.localeCompare(b.name);
    if (n !== 0) return n;
    return a.type.localeCompare(b.type);
  });
  const lines: string[] = ["$ORIGIN ."];
  for (const rr of sorted) {
    const recs = [...rr.records].sort((a, b) => a.content.localeCompare(b.content));
    for (const r of recs) {
      const prefix = r.disabled ? "; DISABLED " : "";
      lines.push(`${prefix}${rr.name}\t${rr.ttl}\tIN\t${rr.type}\t${r.content}`);
    }
  }
  return lines.join("\n") + "\n";
}

function bindFileName(zoneName: string): string {
  // PDNS zone names end with a trailing dot; strip it for the file name.
  // Also strip any path-traversal characters defensively even though
  // PDNS' zone-name regex already excludes them.
  const trimmed = zoneName.replace(/\.$/, "");
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}.zone`;
}
