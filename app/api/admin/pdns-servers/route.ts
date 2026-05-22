/**
 * app/api/admin/pdns-servers/route.ts
 *
 * GET  — list every backend (server.read permission).
 * POST — create a new backend (server.create permission).
 *
 * Writes are audited; the API key is encrypted before insert and never
 * round-tripped to the client. The version-probe runs once after create so
 * the row's `version_cache` is populated immediately; failures don't roll
 * back the insert — the operator can re-test from the admin UI.
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
import {
  findPdnsServerBySlug,
  insertPdnsServer,
  listAllPdnsServers,
} from "@/lib/db/repositories/pdns-servers";
import { createPdnsServerSchema } from "@/lib/validators/pdns-servers";
import { refreshAndPersistVersion } from "@/lib/pdns/registry";
import { assertSafePdnsUrl } from "@/lib/pdns/url-safety";
import { ConflictError } from "@/lib/errors";

export async function GET(): Promise<Response> {
  try {
    const { ability } = await requireUser({ can: "server.read" });
    void ability;
    const rows = await listAllPdnsServers();
    // Strip the encrypted key — never returned over the wire.
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

    const apiKeyEncrypted = encrypt(input.apiKey, "pdns-api-key");
    const row = await insertPdnsServer({
      slug: input.slug,
      name: input.name,
      description: input.description && input.description !== "" ? input.description : null,
      baseUrl: input.baseUrl,
      serverId: input.serverId,
      apiKeyEncrypted,
      isDefault: input.isDefault,
      role: input.role,
      primaryId: input.role === "secondary" ? (input.primaryId ?? null) : null,
      createdBy: user.id,
    });

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "server.create",
      resource: { type: "pdns_server", id: row.id },
      after: {
        slug: row.slug,
        name: row.name,
        description: row.description,
        baseUrl: row.baseUrl,
        serverId: row.serverId,
        isDefault: row.isDefault,
      },
      request: getRequestContext(hdrs),
    });

    // Best-effort version probe so the list view shows health on first paint.
    // Failures are logged and surfaced via the row's empty `versionCache`.
    refreshAndPersistVersion(row.id).catch((err: unknown) => {
      logger.warn(
        {
          server: row.slug,
          error: err instanceof Error ? redact(err.message) : "unknown",
        },
        "pdns.server.first-probe.failed",
      );
    });

    const { apiKeyEncrypted: _strip, ...safe } = row;
    return Response.json({ server: safe }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "pdns-servers.route.error");
  }
}
