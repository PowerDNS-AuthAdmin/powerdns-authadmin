/**
 * app/api/admin/pdns-servers/[id]/route.ts
 *
 * PATCH  — update a backend (server.update). The API key rotates only when
 *          `apiKey` is provided; omit to leave it in place.
 * DELETE — remove a backend (server.delete). Hard-delete; the audit log
 *          carries the historical record.
 *
 * The cached PdnsClient is invalidated on every write so the next request
 * builds against the new config.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { encrypt } from "@/lib/crypto/encryption";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { db } from "@/lib/db";
import {
  deletePdnsServer,
  findPdnsServerById,
  updatePdnsServer,
} from "@/lib/db/repositories/pdns-servers";
import { updatePdnsServerSchema } from "@/lib/validators/pdns-servers";
import { invalidatePdnsClient } from "@/lib/pdns/registry";
import { assertSafePdnsUrl } from "@/lib/pdns/url-safety";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "server.update" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findPdnsServerById(id);
    if (!existing) throw new NotFoundError("PowerDNS server not found.");

    let input: ReturnType<typeof updatePdnsServerSchema.parse>;
    try {
      input = updatePdnsServerSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const patch: Parameters<typeof updatePdnsServer>[1] = {};
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) {
      // Trimmed empty string treated as null clear (matches the
      // create-route normalization).
      patch.description =
        typeof input.description === "string" && input.description !== ""
          ? input.description
          : null;
    }
    if (input.baseUrl !== undefined) {
      await assertSafePdnsUrl(input.baseUrl);
      patch.baseUrl = input.baseUrl;
    }
    if (input.serverId !== undefined) patch.serverId = input.serverId;
    if (input.apiKey !== undefined) {
      patch.apiKeyEncrypted = encrypt(input.apiKey, "pdns-api-key");
      // Clear the cached version snapshot — capabilities should be re-probed
      // against the new credentials before any UI relies on them.
      patch.versionCache = null;
    }
    if (input.isDefault !== undefined) patch.isDefault = input.isDefault;
    if (input.disabled !== undefined) {
      patch.disabledAt = input.disabled ? new Date() : null;
    }
    if (input.role !== undefined) {
      patch.role = input.role;
      // Switching to primary clears any parent reference; switching to
      // secondary leaves `primaryId` to the explicit `primaryId` field
      // below (validator already enforces it's set in that case).
      if (input.role === "primary") patch.primaryId = null;
    }
    if (input.primaryId !== undefined) {
      patch.primaryId = input.primaryId;
    }

    const updated = await updatePdnsServer(id, patch);
    if (!updated) throw new NotFoundError("PowerDNS server not found.");
    invalidatePdnsClient(id);

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "server.update",
      resource: { type: "pdns_server", id },
      before: snapshotForAudit(existing),
      after: snapshotForAudit(updated),
      request: getRequestContext(hdrs),
    });

    const { apiKeyEncrypted: _strip, ...safe } = updated;
    return Response.json({ server: safe });
  } catch (err) {
    return errorResponse(err, "pdns-servers.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "server.delete" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findPdnsServerById(id);
    if (!existing) throw new NotFoundError("PowerDNS server not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await deletePdnsServer(id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "server.delete",
          resource: { type: "pdns_server", id },
          before: snapshotForAudit(existing),
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    // Client-cache eviction runs only after the delete commits.
    invalidatePdnsClient(id);

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "pdns-servers.route.error");
  }
}

/** Strip the encrypted key from a row before stashing it on the audit entry. */
function snapshotForAudit(row: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  baseUrl: string;
  serverId: string;
  isDefault: boolean;
  disabledAt: Date | null;
}) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    baseUrl: row.baseUrl,
    serverId: row.serverId,
    isDefault: row.isDefault,
    disabledAt: row.disabledAt?.toISOString() ?? null,
  };
}
