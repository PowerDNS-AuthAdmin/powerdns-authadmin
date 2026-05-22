/**
 * app/api/admin/oidc-providers/[id]/route.ts
 *
 * PATCH  — update a provider (oidc.manage). The client_secret rotates only
 *          when provided; omit to leave it in place.
 * DELETE — remove a provider (oidc.manage). Hard-delete; the audit log
 *          carries the historical record.
 *
 * On either mutation, the in-process OIDC discovery cache is dropped so
 * the next sign-in re-discovers against the new credentials.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/encryption";
import {
  deleteOidcProvider,
  findOidcProviderById,
  setOidcDiscoveryCache,
  updateOidcProvider,
} from "@/lib/db/repositories/oidc-providers";
import { updateOidcProviderSchema } from "@/lib/validators/oidc-providers";
import { invalidateOidcConfigCache } from "@/lib/auth/providers/oidc";
import { probeOidcDiscovery } from "@/lib/auth/providers/oidc-probe";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { logger } from "@/lib/logger";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "oidc.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findOidcProviderById(id);
    if (!existing) throw new NotFoundError("OIDC provider not found.");

    let input;
    try {
      input = updateOidcProviderSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const patch: Parameters<typeof updateOidcProvider>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.issuerUrl !== undefined) patch.issuerUrl = input.issuerUrl;
    if (input.clientId !== undefined) patch.clientId = input.clientId;
    if (input.clientSecret !== undefined) {
      patch.clientSecretEncrypted = encrypt(input.clientSecret, "oidc-client-secret");
    }
    if (input.scopes !== undefined) patch.scopes = input.scopes;
    if (input.claimEmail !== undefined) patch.claimEmail = input.claimEmail;
    if (input.claimName !== undefined) patch.claimName = input.claimName;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.forceDefault !== undefined) patch.forceDefault = input.forceDefault;
    if (input.requireEmailVerified !== undefined) {
      patch.requireEmailVerified = input.requireEmailVerified;
    }
    // `undefined` = leave unchanged; `null` = clear (back to env inherit);
    // array = set the override. Schema's `.nullable().optional()` carries
    // the three states explicitly.
    if (input.allowedEmailDomains !== undefined) {
      patch.allowedEmailDomains = input.allowedEmailDomains;
    }
    if (input.groupMappings !== undefined) {
      patch.groupMappings = input.groupMappings;
    }
    if (input.iconUrl !== undefined) patch.iconUrl = input.iconUrl;

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const row = await updateOidcProvider(id, patch, tx);
      if (!row) throw new NotFoundError("OIDC provider not found.");

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "oidc.provider.updated",
          resource: { type: "oidc_provider", id },
          before: snapshot(existing),
          after: snapshot(row),
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return row;
    });

    // Cache invalidation runs only after the update commits — invalidating on
    // a rolled-back write would needlessly force a re-discovery.
    invalidateOidcConfigCache();

    // Re-probe when the issuer URL actually changed. The cached
    // discovery result was bound to the OLD url; leaving it would mislead operators
    // reading the badge. Fire-and-forget so the PATCH response
    // doesn't block on a 5s probe. Skip when only non-URL fields
    // changed.
    if (input.issuerUrl !== undefined && updated.issuerUrl !== existing.issuerUrl) {
      void (async () => {
        try {
          const result = await probeOidcDiscovery(updated.issuerUrl);
          await setOidcDiscoveryCache(updated.id, {
            fetchedAt: new Date().toISOString(),
            ok: result.ok,
            ...(result.ok ? {} : { reason: result.reason }),
          });
        } catch (err) {
          logger.warn(
            {
              provider: updated.slug,
              error: err instanceof Error ? err.message : "unknown",
            },
            "oidc.provider.edit-probe.failed",
          );
        }
      })();
    }

    const { clientSecretEncrypted: _strip, ...safe } = updated;
    return Response.json({ provider: safe });
  } catch (err) {
    return errorResponse(err, "admin.oidc-providers.id.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "oidc.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findOidcProviderById(id);
    if (!existing) throw new NotFoundError("OIDC provider not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await deleteOidcProvider(id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "oidc.provider.deleted",
          resource: { type: "oidc_provider", id },
          before: snapshot(existing),
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    // Cache invalidation runs only after the delete commits.
    invalidateOidcConfigCache();

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.oidc-providers.id.route.error");
  }
}

function snapshot(row: {
  id: string;
  slug: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  scopes: string;
  claimEmail: string;
  claimName: string;
  enabled: boolean;
  forceDefault: boolean;
  requireEmailVerified: boolean;
  allowedEmailDomains: string[] | null;
  groupMappings: ReadonlyArray<{
    group: string;
    roleSlug: string;
    scopeType: "global" | "team" | "zone" | "server";
    scopeId: string | null;
  }> | null;
  iconUrl: string | null;
}) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    scopes: row.scopes,
    claimEmail: row.claimEmail,
    claimName: row.claimName,
    enabled: row.enabled,
    forceDefault: row.forceDefault,
    requireEmailVerified: row.requireEmailVerified,
    allowedEmailDomains: row.allowedEmailDomains,
    groupMappingsCount: row.groupMappings?.length ?? 0,
    // Icon URL itself may be huge (inline data: URI) — don't bloat
    // audit before/after with the bytes. Capture only "set / unset"
    // for the diff; operators reviewing changes care that an icon
    // changed, not the specific base64 payload.
    iconUrlSet: row.iconUrl !== null,
  };
}
