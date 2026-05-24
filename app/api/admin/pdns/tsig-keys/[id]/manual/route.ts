/**
 * app/api/admin/pdns/tsig-keys/[id]/manual/route.ts
 *
 * POST — return a copy-paste `pdnsutil` script to install this TSIG key on the
 *        secondaries by hand (older daemons without the TSIG API, air-gapped
 *        boxes, or operators who prefer the CLI). The script contains the
 *        plaintext secret, so — like the S-8 reveal — it's returned as
 *        `text/plain` (never a JSON body that loggers/devtools would retain) and
 *        audited as a reveal.
 *
 * Version-agnostic: uses `import-tsig-key` + `set-meta` (stable across the
 * master/slave → primary/secondary rename).
 *
 * Permission: `tsig.manage` (it exposes the secret).
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { listPrimarySecondaries } from "@/lib/realtime/tsig-replication";
import { readCachedZones } from "@/lib/pdns/zone-state-cache";
import { tsigManualCommands } from "@/lib/pdns/tsig-install";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { errorResponse } from "@/lib/http/error-response";

const bodySchema = z.object({ serverSlug: z.string().optional() });

const PRIMARY_KINDS = new Set(["master", "primary"]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "tsig.manage" });
    await requireCsrf(request);
    const { id } = await context.params;
    const keyId = decodeURIComponent(id);

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json().catch(() => ({})));
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      }
      throw err;
    }

    const primary = body.serverSlug
      ? await findPdnsServerBySlug(body.serverSlug)
      : await findDefaultPdnsServer();
    if (primary?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }

    let detail;
    try {
      detail = await getBackendGateway(primary).getTsigKey(keyId);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) throw new NotFoundError("TSIG key not found.");
      throw err;
    }

    // The primary's authoritative zones (those a secondary would AXFR), from the
    // broker cache — no extra PDNS call.
    const zones = [...(readCachedZones(primary.id)?.zones.values() ?? [])]
      .filter((z) => PRIMARY_KINDS.has(z.kind.toLowerCase()))
      .map((z) => z.name)
      .sort();
    const secondaries = await listPrimarySecondaries(primary);

    // PDNS 5.0 restructured pdnsutil (`<verb>-tsig-key` → `tsigkey <verb>`).
    // Emit the form matching the primary's major version (the daemon the
    // operator is provisioning from); the script notes the alternative.
    const modernCli = (primary.versionCache?.parsed.major ?? 0) >= 5;
    const cmds = tsigManualCommands(
      { name: detail.name, algorithm: detail.algorithm, secret: detail.key },
      zones,
      { modernCli },
    );
    const script = buildScript(detail.name, detail.algorithm, cmds, secondaries, modernCli);

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "tsig.manual-reveal",
      resource: { type: "tsig", id: `${primary.slug}:${keyId}` },
      after: { keyName: detail.name, zones: zones.length, revealedForManualSetup: true },
      request: getRequestContext(hdrs),
    });

    // text/plain, no-store — the secret must not be cached or JSON-logged.
    return new Response(script, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err, "pdns.tsig.manual.error");
  }
}

function buildScript(
  name: string,
  algorithm: string,
  cmds: ReturnType<typeof tsigManualCommands>,
  secondaries: ReadonlyArray<{ slug: string; name: string }>,
  modernCli: boolean,
): string {
  const lines: string[] = [
    `# TSIG key "${name}" (${algorithm}) — manual install`,
    `# Commands match PowerDNS ${modernCli ? "5.0+ (pdnsutil tsigkey …)" : "4.x (pdnsutil …-tsig-key)"}.`,
    secondaries.length > 0
      ? `# Secondaries: ${secondaries.map((s) => s.name).join(", ")}`
      : `# No managed secondaries detected — run on each box that should mirror this primary.`,
    "",
    "# 1) On EACH secondary, import the shared secret:",
    cmds.importOnSecondary,
  ];
  if (cmds.secondaryPerZone.length > 0) {
    lines.push("", "# 2) On EACH secondary, sign AXFR for each zone with this key:");
    lines.push(...cmds.secondaryPerZone);
    lines.push("", "# 3) On the PRIMARY, allow this key to AXFR each zone:");
    lines.push(...cmds.primaryPerZone);
  }
  return lines.join("\n") + "\n";
}
