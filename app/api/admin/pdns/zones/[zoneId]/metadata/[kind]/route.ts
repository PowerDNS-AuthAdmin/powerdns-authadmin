/**
 * app/api/admin/pdns/zones/[zoneId]/metadata/[kind]/route.ts
 *
 * PUT    — replace all values for a single metadata kind. Upsert
 *          semantics (PDNS creates the kind if it didn't exist).
 *          Permission: `metadata.write`.
 * DELETE — remove the kind entirely. Permission: `metadata.write`.
 *
 * The route validates the `kind` path segment server-side (PDNS
 * accepts arbitrary strings, but operators get a better experience
 * when we refuse the obvious garbage at the boundary). The audit
 * snapshot captures both `before` (the existing values) and `after`
 * (what we asked PDNS to store) so reviewers can see exactly what
 * the operator changed.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

// PDNS metadata kinds are uppercase ASCII letters / digits / hyphens,
// e.g. `ALSO-NOTIFY`. The regex below accepts that shape and rejects
// obvious abuse (spaces, slashes, control bytes).
const kindShape = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9-]*$/, "Kind must be uppercase letters, digits, or hyphens.");

const putBodySchema = z.object({
  serverSlug: z.string().optional(),
  // PDNS stores everything as strings; even numeric-looking values
  // (like `API-RECTIFY: "1"`) round-trip as strings.
  values: z.array(z.string().max(2048)).max(256),
});

const deleteQuerySchema = z.object({
  serverSlug: z.string().optional(),
});

interface RouteContext {
  params: Promise<{ zoneId: string; kind: string }>;
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    // Authenticate without the type-level `can:` short-circuit — we
    // grant on EITHER the type-level role permission OR a per-zone
    // grant via `canActOnZone` below.
    const { user: actor, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);

    const { zoneId, kind: rawKind } = await context.params;
    const kind = parseKind(rawKind);

    let body;
    try {
      body = putBodySchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const selected = await resolveServer(body.serverSlug);
    const client = getBackendGateway(selected);
    const zoneName = decodeURIComponent(zoneId);

    if (
      !canActOnZone({
        hasGlobalPermission: globalPermissions.has("metadata.write"),
        grants: zoneGrants,
        serverId: selected.id,
        zoneName,
        permission: "metadata.write",
      })
    ) {
      throw new ForbiddenError("Missing metadata.write for this zone.");
    }

    // Snapshot the existing values for the audit `before` field. This is
    // a separate HTTP round-trip but it's cheap and the audit clarity
    // is worth it.
    const before = await snapshotKind(client, zoneName, kind);

    const updated = await client.setZoneMetadata(zoneName, kind, body.values);

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "zone.metadata.set",
      resource: { type: "zone", id: `${selected.slug}:${zoneName}` },
      before: before ? { kind: before.kind, values: before.metadata } : null,
      after: { kind: updated.kind, values: updated.metadata },
      request: getRequestContext(hdrs),
    });

    publishZoneEvent({
      type: "zone.updated",
      zone: zoneName,
      serverSlug: selected.slug,
      actor: actor.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    return Response.json({ ok: true, metadata: updated });
  } catch (err) {
    return errorResponse(err, "zone.metadata.set");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    // Same EITHER-OR pattern as PUT — see comment there.
    const { user: actor, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);

    const { zoneId, kind: rawKind } = await context.params;
    const kind = parseKind(rawKind);
    const url = new URL(request.url);
    const { serverSlug } = deleteQuerySchema.parse(Object.fromEntries(url.searchParams));

    const selected = await resolveServer(serverSlug);
    const client = getBackendGateway(selected);
    const zoneName = decodeURIComponent(zoneId);

    if (
      !canActOnZone({
        hasGlobalPermission: globalPermissions.has("metadata.write"),
        grants: zoneGrants,
        serverId: selected.id,
        zoneName,
        permission: "metadata.write",
      })
    ) {
      throw new ForbiddenError("Missing metadata.write for this zone.");
    }

    const before = await snapshotKind(client, zoneName, kind);
    await client.deleteZoneMetadata(zoneName, kind);

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "zone.metadata.delete",
      resource: { type: "zone", id: `${selected.slug}:${zoneName}` },
      before: before ? { kind: before.kind, values: before.metadata } : null,
      after: null,
      request: getRequestContext(hdrs),
    });

    publishZoneEvent({
      type: "zone.updated",
      zone: zoneName,
      serverSlug: selected.slug,
      actor: actor.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "zone.metadata.delete");
  }
}

/**
 * Capture the current values for a kind for the audit `before` snapshot.
 * Try GET first; if PDNS returns null (404 or 422 — some kinds aren't
 * GET-able individually even though they're in the LIST), fall back to
 * scanning the full metadata list for a match. Returns null when the
 * kind truly isn't set.
 */
async function snapshotKind(
  client: ReturnType<typeof getBackendGateway>,
  zoneName: string,
  kind: string,
): Promise<{ kind: string; metadata: string[] } | null> {
  const direct = await client.getZoneMetadata(zoneName, kind);
  if (direct) return direct;
  const list = await client.listZoneMetadata(zoneName).catch(() => null);
  return list?.find((m) => m.kind === kind) ?? null;
}

function parseKind(raw: string): string {
  const decoded = decodeURIComponent(raw);
  const parsed = kindShape.safeParse(decoded);
  if (!parsed.success) {
    throw new ValidationError("Invalid metadata kind.", {
      fieldErrors: { kind: parsed.error.issues.map((i) => i.message) },
    });
  }
  return parsed.data;
}

async function resolveServer(slug: string | undefined) {
  const selected = slug ? await findPdnsServerBySlug(slug) : await findDefaultPdnsServer();
  if (selected?.disabledAt !== null) {
    throw new NotFoundError("No PDNS backend selected.");
  }
  return selected;
}
