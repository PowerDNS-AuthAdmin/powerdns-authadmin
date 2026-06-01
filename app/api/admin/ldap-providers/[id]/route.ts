/**
 * app/api/admin/ldap-providers/[id]/route.ts
 *
 * PATCH  - update a provider. The bind password rotates only when provided;
 *          omit to leave the encrypted envelope in place.
 * DELETE - remove a provider. Hard-delete; the audit log keeps the history.
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
  deleteLdapProvider,
  findLdapProviderById,
  updateLdapProvider,
} from "@/lib/db/repositories/ldap-providers";
import { updateLdapProviderSchema } from "@/lib/validators/ldap-providers";
import { releaseProviderSlug } from "@/lib/db/repositories/auth-provider-slugs";
import { assertGroupMappingsWithinCeiling } from "@/lib/rbac/oidc-mapping-ceiling";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "auth.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findLdapProviderById(id);
    if (!existing) throw new NotFoundError("LDAP provider not found.");

    let input;
    try {
      input = updateLdapProviderSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    if (input.groupMappings !== undefined) {
      await assertGroupMappingsWithinCeiling(user.id, input.groupMappings);
    }

    const patch: Parameters<typeof updateLdapProvider>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.serverUrl !== undefined) patch.serverUrl = input.serverUrl;
    if (input.startTls !== undefined) patch.startTls = input.startTls;
    if (input.bindDn !== undefined) patch.bindDn = input.bindDn;
    if (input.bindPassword !== undefined) {
      patch.bindPasswordEncrypted = encrypt(input.bindPassword, "ldap-bind-password");
    }
    if (input.userSearchBase !== undefined) patch.userSearchBase = input.userSearchBase;
    if (input.userSearchFilter !== undefined) patch.userSearchFilter = input.userSearchFilter;
    if (input.groupSearchBase !== undefined) patch.groupSearchBase = input.groupSearchBase;
    if (input.groupSearchFilter !== undefined) patch.groupSearchFilter = input.groupSearchFilter;
    if (input.groupAttr !== undefined) patch.groupAttr = input.groupAttr;
    if (input.claimEmail !== undefined) patch.claimEmail = input.claimEmail;
    if (input.claimName !== undefined) patch.claimName = input.claimName;
    if (input.tlsCaCert !== undefined) patch.tlsCaCert = input.tlsCaCert;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.allowedEmailDomains !== undefined) {
      patch.allowedEmailDomains = input.allowedEmailDomains;
    }
    if (input.groupMappings !== undefined) {
      patch.groupMappings = input.groupMappings;
    }

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const row = await updateLdapProvider(id, patch, tx);
      if (!row) throw new NotFoundError("LDAP provider not found.");

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "ldap.provider.updated",
          resource: { type: "ldap_provider", id },
          before: snapshot(existing),
          after: snapshot(row),
          request: getRequestContext(hdrs),
        },
        tx,
      );
      return row;
    });

    const { bindPasswordEncrypted: _strip, tlsCaCert: _ca, ...safe } = updated;
    return Response.json({
      provider: { ...safe, tlsCaCertSet: updated.tlsCaCert !== null },
    });
  } catch (err) {
    return errorResponse(err, "admin.ldap-providers.id.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "auth.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findLdapProviderById(id);
    if (!existing) throw new NotFoundError("LDAP provider not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await deleteLdapProvider(id, tx);
      await releaseProviderSlug(existing.slug, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "ldap.provider.deleted",
          resource: { type: "ldap_provider", id },
          before: snapshot(existing),
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.ldap-providers.id.route.error");
  }
}

function snapshot(row: {
  id: string;
  slug: string;
  name: string;
  serverUrl: string;
  startTls: boolean;
  bindDn: string;
  userSearchBase: string;
  userSearchFilter: string;
  groupSearchBase: string | null;
  groupSearchFilter: string | null;
  groupAttr: string;
  claimEmail: string;
  claimName: string;
  enabled: boolean;
  allowedEmailDomains: string[] | null;
  groupMappings: ReadonlyArray<{
    group: string;
    roleSlug: string;
    scopeType: "global" | "team" | "zone" | "server";
    scopeId: string | null;
  }> | null;
  tlsCaCert: string | null;
}) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    serverUrl: row.serverUrl,
    startTls: row.startTls,
    bindDn: row.bindDn,
    userSearchBase: row.userSearchBase,
    userSearchFilter: row.userSearchFilter,
    groupSearchBase: row.groupSearchBase,
    groupSearchFilter: row.groupSearchFilter,
    groupAttr: row.groupAttr,
    claimEmail: row.claimEmail,
    claimName: row.claimName,
    enabled: row.enabled,
    allowedEmailDomains: row.allowedEmailDomains,
    groupMappingsCount: row.groupMappings?.length ?? 0,
    tlsCaCertSet: row.tlsCaCert !== null,
  };
}
