/**
 * app/api/admin/saml-providers/route.ts
 *
 * GET  — list every SAML provider (oidc.read; SAML reuses the OIDC perm pair
 *        per ADR-0021 since both are "configure SSO" verbs).
 * POST — create a new SAML provider (oidc.manage). The SP signing key + the
 *        optional encryption key are encrypted before insert.
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
  findSamlProviderBySlug,
  insertSamlProvider,
  listAllSamlProviders,
} from "@/lib/db/repositories/saml-providers";
import { createSamlProviderSchema } from "@/lib/validators/saml-providers";
import {
  lookupProviderTypeBySlug,
  reserveProviderSlug,
} from "@/lib/db/repositories/auth-provider-slugs";
import { assertGroupMappingsWithinCeiling } from "@/lib/rbac/oidc-mapping-ceiling";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

/** Strip secret PEM columns before returning a row over the wire. */
function safeRow<
  T extends { spSigningKeyEncrypted: string; spEncryptionKeyEncrypted: string | null },
>(row: T): Omit<T, "spSigningKeyEncrypted" | "spEncryptionKeyEncrypted"> {
  const { spSigningKeyEncrypted: _strip1, spEncryptionKeyEncrypted: _strip2, ...rest } = row;
  return rest;
}

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "oidc.read" });
    const rows = await listAllSamlProviders();
    return Response.json(
      { providers: rows.map(safeRow) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "admin.saml-providers.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "oidc.manage" });
    await requireCsrf(request);

    let input;
    try {
      input = createSamlProviderSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const existing = await findSamlProviderBySlug(input.slug);
    if (existing) {
      throw new ConflictError(`A SAML provider with slug "${input.slug}" already exists.`);
    }
    const existingType = await lookupProviderTypeBySlug(input.slug);
    if (existingType !== null) {
      throw new ConflictError(
        `Slug "${input.slug}" is already used by a ${existingType.toUpperCase()} provider. Slugs are unique across every authentication provider.`,
      );
    }

    // Privilege ceiling: same as OIDC — group→role mappings can't carry
    // permissions the actor lacks globally (defends against IdP-launder
    // privilege escalation).
    await assertGroupMappingsWithinCeiling(user.id, input.groupMappings ?? null);

    // Cross-pair sanity: if either encryption half is set, both must be.
    if (
      (input.spEncryptionKey && !input.spEncryptionCert) ||
      (!input.spEncryptionKey && input.spEncryptionCert)
    ) {
      throw new ValidationError(
        "SP encryption key and cert must be supplied together (both PEMs, or neither).",
      );
    }

    const spSigningKeyEncrypted = encrypt(input.spSigningKey, "saml-sp-signing-key");
    const spEncryptionKeyEncrypted = input.spEncryptionKey
      ? encrypt(input.spEncryptionKey, "saml-sp-encryption-key")
      : null;

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      // Reserve the slug cross-type first. PK constraint races with OIDC/LDAP
      // creates resolve atomically inside this transaction.
      await reserveProviderSlug({ slug: input.slug, providerType: "saml" }, tx);
      const created = await insertSamlProvider(
        {
          slug: input.slug,
          name: input.name,
          idpEntityId: input.idpEntityId,
          idpSsoUrl: input.idpSsoUrl,
          idpSloUrl: input.idpSloUrl ?? null,
          idpSigningCert: input.idpSigningCert,
          spSigningKeyEncrypted,
          spSigningCert: input.spSigningCert,
          spEncryptionKeyEncrypted,
          spEncryptionCert: input.spEncryptionCert ?? null,
          requireSignedResponse: input.requireSignedResponse,
          requireEncryptedAssertion: input.requireEncryptedAssertion,
          signatureAlgorithm: input.signatureAlgorithm,
          nameIdFormat: input.nameIdFormat,
          claimEmail: input.claimEmail,
          claimName: input.claimName,
          claimGroups: input.claimGroups,
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
          action: "saml.provider.created",
          resource: { type: "saml_provider", id: created.id },
          after: snapshot(created),
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    return Response.json({ provider: safeRow(row) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.saml-providers.route.error");
  }
}

function snapshot(row: {
  id: string;
  slug: string;
  name: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl: string | null;
  requireSignedResponse: boolean;
  requireEncryptedAssertion: boolean;
  signatureAlgorithm: string;
  nameIdFormat: string;
  claimEmail: string;
  claimName: string;
  claimGroups: string;
  enabled: boolean;
  allowedEmailDomains: string[] | null;
  groupMappings: readonly unknown[] | null;
  spEncryptionCert: string | null;
}) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpSloUrl: row.idpSloUrl,
    requireSignedResponse: row.requireSignedResponse,
    requireEncryptedAssertion: row.requireEncryptedAssertion,
    signatureAlgorithm: row.signatureAlgorithm,
    nameIdFormat: row.nameIdFormat,
    claimEmail: row.claimEmail,
    claimName: row.claimName,
    claimGroups: row.claimGroups,
    enabled: row.enabled,
    allowedEmailDomains: row.allowedEmailDomains,
    groupMappingsCount: row.groupMappings?.length ?? 0,
    encryptionSet: row.spEncryptionCert !== null,
  };
}
