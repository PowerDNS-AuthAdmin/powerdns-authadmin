/**
 * app/api/admin/ldap-providers/route.ts
 *
 * GET  — list every LDAP provider (gated by `oidc.read`; the unified
 *        Authentication admin view treats LDAP as one of several
 *        provider types alongside OIDC).
 * POST — create a new provider (gated by `oidc.manage`). The bind
 *        password is encrypted before insert and never returned over
 *        the wire.
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
  findLdapProviderBySlug,
  insertLdapProvider,
  listAllLdapProviders,
} from "@/lib/db/repositories/ldap-providers";
import { createLdapProviderSchema } from "@/lib/validators/ldap-providers";
import {
  lookupProviderTypeBySlug,
  reserveProviderSlug,
} from "@/lib/db/repositories/auth-provider-slugs";
import { assertGroupMappingsWithinCeiling } from "@/lib/rbac/oidc-mapping-ceiling";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "oidc.read" });
    const rows = await listAllLdapProviders();
    // Never return the encrypted secret over the wire. Strip the CA cert
    // too — it can be sizable and isn't needed by the list view.
    const safe = rows.map(({ bindPasswordEncrypted: _drop, tlsCaCert: _drop2, ...rest }) => ({
      ...rest,
      tlsCaCertSet: rows.some((r) => r.id === rest.id && r.tlsCaCert !== null),
    }));
    return Response.json({ providers: safe }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "admin.ldap-providers.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "oidc.manage" });
    await requireCsrf(request);

    let input;
    try {
      input = createLdapProviderSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const existing = await findLdapProviderBySlug(input.slug);
    if (existing) {
      throw new ConflictError(`An LDAP provider with slug "${input.slug}" already exists.`);
    }
    // Cross-type slug uniqueness: refuse to create an LDAP provider whose
    // slug is already taken by OIDC or SAML. Same handshake the OIDC create
    // uses; the PK constraint inside the transaction is the real guard,
    // the up-front check gives a cleaner error.
    const existingType = await lookupProviderTypeBySlug(input.slug);
    if (existingType !== null) {
      throw new ConflictError(
        `Slug "${input.slug}" is already used by a ${existingType.toUpperCase()} provider. Slugs are unique across every authentication provider.`,
      );
    }

    // Privilege ceiling — same guard as OIDC. LDAP group mappings auto-
    // assign roles at first sign-in, so they can't carry permissions the
    // actor lacks globally. The same helper handles both provider types
    // because the mapping shape is identical.
    await assertGroupMappingsWithinCeiling(user.id, input.groupMappings ?? null);

    const bindPasswordEncrypted = encrypt(input.bindPassword, "ldap-bind-password");

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      await reserveProviderSlug({ slug: input.slug, providerType: "ldap" }, tx);
      const created = await insertLdapProvider(
        {
          slug: input.slug,
          name: input.name,
          serverUrl: input.serverUrl,
          startTls: input.startTls,
          bindDn: input.bindDn,
          bindPasswordEncrypted,
          userSearchBase: input.userSearchBase,
          userSearchFilter: input.userSearchFilter,
          groupSearchBase: input.groupSearchBase ?? null,
          groupSearchFilter: input.groupSearchFilter ?? null,
          groupAttr: input.groupAttr,
          claimEmail: input.claimEmail,
          claimName: input.claimName,
          tlsCaCert: input.tlsCaCert ?? null,
          enabled: input.enabled,
          allowedEmailDomains: input.allowedEmailDomains ?? null,
          groupMappings: input.groupMappings ?? null,
          createdBy: user.id,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "ldap.provider.created",
          resource: { type: "ldap_provider", id: created.id },
          after: snapshot(created),
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    const { bindPasswordEncrypted: _strip, tlsCaCert: _ca, ...safe } = row;
    return Response.json(
      { provider: { ...safe, tlsCaCertSet: row.tlsCaCert !== null } },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "admin.ldap-providers.route.error");
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
    // Bytes themselves don't go into the audit row (PEM blobs are big);
    // just whether a pin is set.
    tlsCaCertSet: row.tlsCaCert !== null,
  };
}
