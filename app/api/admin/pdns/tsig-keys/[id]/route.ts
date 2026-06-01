/**
 * app/api/admin/pdns/tsig-keys/[id]/route.ts
 *
 * DELETE - remove a TSIG key from the PDNS backend. Permission:
 *          `tsig.manage`. Audit captures the name (the only
 *          identifying field the operator usually remembers); the
 *          secret is never logged.
 *
 * Rename / regenerate (`PUT`) is intentionally not implemented in
 * this slice - operators rotate TSIG keys by creating a new key and
 * updating their secondary configs, then deleting the old key. That
 * workflow happens to be the same physical sequence PUT would
 * achieve, but with explicit audit rows for each step.
 */

import { headers } from "next/headers";
import { z } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { cascadeDeleteTsigKey } from "@/lib/realtime/tsig-replication";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { errorResponse } from "@/lib/http/error-response";
import { NotFoundError } from "@/lib/errors";

const querySchema = z.object({
  serverSlug: z.string().optional(),
  // `true` (the UI default) also strips the key from every zone using it and
  // deletes the replicated copy from secondaries; `false`/absent = key only.
  cascade: z.enum(["true", "false"]).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "tsig.manage" });
    await requireCsrf(request);

    const { id: rawId } = await context.params;
    const keyId = decodeURIComponent(rawId);

    const url = new URL(request.url);
    const { serverSlug, cascade } = querySchema.parse(Object.fromEntries(url.searchParams));
    const doCascade = cascade === "true";

    const selected = serverSlug
      ? await findPdnsServerBySlug(serverSlug)
      : await findDefaultPdnsServer();
    if (selected?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }
    const client = getBackendGateway(selected);

    // Best-effort "before" snapshot. Strips `key` explicitly before
    // it reaches the audit shape - the redactor would catch it too,
    // but destructuring is the primary defense.
    let nameSnapshot: string | null = null;
    let algorithmSnapshot: string | null = null;
    try {
      const before = await client.getTsigKey(keyId);
      nameSnapshot = before.name;
      algorithmSnapshot = before.algorithm;
    } catch (err) {
      if (!(err instanceof PdnsNotFoundError)) throw err;
      // PDNS already returned 404 - treat the delete as already done.
      throw new NotFoundError("TSIG key not found.");
    }

    // Default delete path: strip the key from every zone using it and remove the
    // replicated copy from the secondaries, then delete it from the primary. The
    // zone scan reads zone names from the broker cache, so warm it first.
    // Opt-out (`cascade !== "true"`) deletes the key from this backend only.
    let cascadeResult: { zonesUpdated: number; secondariesCleaned: number } | null = null;
    if (doCascade) {
      await ensureBackendsObserved();
      const { zonesUpdated, secondariesCleaned } = await cascadeDeleteTsigKey(selected, keyId);
      cascadeResult = { zonesUpdated, secondariesCleaned };
    } else {
      await client.deleteTsigKey(keyId);
    }

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "tsig.delete",
      resource: { type: "tsig", id: keyId },
      before: { name: nameSnapshot, algorithm: algorithmSnapshot },
      after: cascadeResult ? { cascaded: true, ...cascadeResult } : null,
      request: getRequestContext(hdrs),
    });

    return Response.json({ ok: true, cascade: cascadeResult });
  } catch (err) {
    return errorResponse(err, "pdns.tsig.route.error");
  }
}
