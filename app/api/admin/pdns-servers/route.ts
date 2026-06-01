/**
 * app/api/admin/pdns-servers/route.ts
 *
 * GET  - list every backend (server.read permission).
 * POST - create a new backend (server.create permission).
 *
 * Writes are audited; the API key is encrypted before insert and never
 * round-tripped to the client. The version-probe runs once after create so
 * the row's `version_cache` is populated immediately; failures don't roll
 * back the insert - the operator can re-test from the admin UI.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { encrypt } from "@/lib/crypto/encryption";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { db } from "@/lib/db";
import {
  findPdnsServerBySlug,
  insertPdnsServer,
  listAllPdnsServers,
} from "@/lib/db/repositories/pdns-servers";
import { createPdnsServerSchema } from "@/lib/validators/pdns-servers";
import { refreshBackendHealth } from "@/lib/realtime/backend-health";
import { assertSafePdnsUrl } from "@/lib/pdns/url-safety";
import { ConflictError } from "@/lib/errors";
import { findClusterById } from "@/lib/db/repositories/pdns-clusters";
import { invalidateBackendObservation, scheduleImmediatePoll } from "@/lib/realtime/zone-poller";

export async function GET(): Promise<Response> {
  try {
    const { ability } = await requireUser({ can: "server.read" });
    void ability;
    const rows = await listAllPdnsServers();
    // Strip the encrypted key - never returned over the wire.
    const safe = rows.map(({ apiKeyEncrypted: _unused, ...rest }) => rest);
    return Response.json({ servers: safe }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "pdns-servers.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "server.create" });
    await requireCsrf(request);

    let input: ReturnType<typeof createPdnsServerSchema.parse>;
    try {
      input = createPdnsServerSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const existing = await findPdnsServerBySlug(input.slug);
    if (existing) {
      throw new ConflictError(`A PowerDNS server with slug "${input.slug}" already exists.`);
    }

    // SSRF guard: resolve the hostname and reject loopback / RFC1918 /
    // link-local. The HTTP client re-validates before each request to defend
    // against DNS rebinding.
    await assertSafePdnsUrl(input.baseUrl);

    // Reject a nonexistent group with a clean 400 rather than letting the FK
    // constraint surface as a 500.
    if (input.clusterId && !(await findClusterById(input.clusterId))) {
      throw new ValidationError("Invalid input.", {
        fieldErrors: { clusterId: ["That group no longer exists."] },
      });
    }

    const apiKeyEncrypted = encrypt(input.apiKey, "pdns-api-key");
    const hdrs = await headers();
    // One transaction: the single-default clearing, the insert, and the audit
    // write commit together or not at all (atomic mutation + audit, ADR audit
    // tx pattern). Failing the audit no longer leaves an unaudited server row.
    const row = await db.transaction(async (tx) => {
      const created = await insertPdnsServer(
        {
          slug: input.slug,
          name: input.name,
          description: input.description && input.description !== "" ? input.description : null,
          baseUrl: input.baseUrl,
          serverId: input.serverId,
          apiKeyEncrypted,
          isDefault: input.isDefault,
          clusterId: input.clusterId ?? null,
          advertisedAddresses:
            input.advertisedAddresses && input.advertisedAddresses.length > 0
              ? input.advertisedAddresses
              : null,
          createdBy: user.id,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "server.create",
          resource: { type: "pdns_server", id: created.id },
          after: {
            slug: created.slug,
            name: created.name,
            description: created.description,
            baseUrl: created.baseUrl,
            serverId: created.serverId,
            isDefault: created.isDefault,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    // Best-effort first health probe so the list view shows real status +
    // version + capabilities on first paint. Failures are logged; the row's
    // status reflects them on the next poll regardless.
    refreshBackendHealth(row, { immediate: true }).catch((err: unknown) => {
      logger.warn(
        {
          server: row.slug,
          error: err instanceof Error ? redact(err.message) : "unknown",
        },
        "pdns.server.first-probe.failed",
      );
    });

    // A new backend changes the replication topology (it may be a primary that
    // others mirror, or a secondary that derives from one). Invalidate the
    // broker so the post-create render re-derives at once (the redirect out-runs
    // the debounced poll), and schedule the poll for any other open views.
    invalidateBackendObservation();
    scheduleImmediatePoll();

    const { apiKeyEncrypted: _strip, ...safe } = row;
    return Response.json({ server: safe }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "pdns-servers.route.error");
  }
}
