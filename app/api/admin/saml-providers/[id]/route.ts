/**
 * app/api/admin/saml-providers/[id]/route.ts
 *
 * PATCH  — update a SAML provider (oidc.manage). Both halves of the SP
 *          signing keypair rotate together; encryption keypair is three-
 *          state (omit / null / set).
 * DELETE — remove a SAML provider (oidc.manage). Hard-delete; the audit log
 *          carries the historical record.
 *
 * Cache invalidation runs on success so the next sign-in re-discovers
 * against the new credentials.
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
  deleteSamlProvider,
  findSamlProviderById,
  updateSamlProvider,
} from "@/lib/db/repositories/saml-providers";
import { updateSamlProviderSchema } from "@/lib/validators/saml-providers";
import { releaseProviderSlug } from "@/lib/db/repositories/auth-provider-slugs";
import { invalidateSamlConfigCache } from "@/lib/auth/providers/saml";
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

    const existing = await findSamlProviderById(id);
    if (!existing) throw new NotFoundError("SAML provider not found.");

    let input;
    try {
      input = updateSamlProviderSchema.parse(await request.json());
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

    // Signing keypair: both halves rotate together — sending one without the
    // other would orphan the cert against a mismatched key.
    if (
      (input.spSigningKey !== undefined && input.spSigningCert === undefined) ||
      (input.spSigningKey === undefined && input.spSigningCert !== undefined)
    ) {
      throw new ValidationError(
        "Rotating the SP signing keypair requires sending BOTH key and cert.",
      );
    }
    // Encryption pair has the same all-or-nothing constraint, applied to
    // each non-undefined leg. A null-null pair clears the pair (removes
    // encryption support); a PEM-PEM pair sets it.
    if (input.spEncryptionKey !== undefined || input.spEncryptionCert !== undefined) {
      const keyNext = input.spEncryptionKey;
      const certNext = input.spEncryptionCert;
      if ((keyNext === null) !== (certNext === null)) {
        throw new ValidationError(
          "SP encryption key and cert must move together (both PEMs, or both null).",
        );
      }
    }

    const patch: Parameters<typeof updateSamlProvider>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.idpEntityId !== undefined) patch.idpEntityId = input.idpEntityId;
    if (input.idpSsoUrl !== undefined) patch.idpSsoUrl = input.idpSsoUrl;
    if (input.idpSloUrl !== undefined) patch.idpSloUrl = input.idpSloUrl;
    if (input.idpSigningCert !== undefined) patch.idpSigningCert = input.idpSigningCert;
    if (input.spSigningKey !== undefined && input.spSigningCert !== undefined) {
      patch.spSigningKeyEncrypted = encrypt(input.spSigningKey, "saml-sp-signing-key");
      patch.spSigningCert = input.spSigningCert;
    }
    if (input.spEncryptionKey !== undefined) {
      patch.spEncryptionKeyEncrypted =
        input.spEncryptionKey === null
          ? null
          : encrypt(input.spEncryptionKey, "saml-sp-encryption-key");
    }
    if (input.spEncryptionCert !== undefined) patch.spEncryptionCert = input.spEncryptionCert;
    if (input.requireSignedResponse !== undefined) {
      patch.requireSignedResponse = input.requireSignedResponse;
    }
    if (input.requireEncryptedAssertion !== undefined) {
      patch.requireEncryptedAssertion = input.requireEncryptedAssertion;
    }
    if (input.signatureAlgorithm !== undefined) patch.signatureAlgorithm = input.signatureAlgorithm;
    if (input.nameIdFormat !== undefined) patch.nameIdFormat = input.nameIdFormat;
    if (input.claimEmail !== undefined) patch.claimEmail = input.claimEmail;
    if (input.claimName !== undefined) patch.claimName = input.claimName;
    if (input.claimGroups !== undefined) patch.claimGroups = input.claimGroups;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.allowedEmailDomains !== undefined) {
      patch.allowedEmailDomains = input.allowedEmailDomains;
    }
    if (input.groupMappings !== undefined) patch.groupMappings = input.groupMappings;

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const row = await updateSamlProvider(id, patch, tx);
      if (!row) throw new NotFoundError("SAML provider not found.");

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "saml.provider.updated",
          resource: { type: "saml_provider", id },
          before: snapshot(existing),
          after: snapshot(row),
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return row;
    });

    invalidateSamlConfigCache();

    const { spSigningKeyEncrypted: _s1, spEncryptionKeyEncrypted: _s2, ...safe } = updated;
    return Response.json({ provider: safe });
  } catch (err) {
    return errorResponse(err, "admin.saml-providers.id.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "auth.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findSamlProviderById(id);
    if (!existing) throw new NotFoundError("SAML provider not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await deleteSamlProvider(id, tx);
      await releaseProviderSlug(existing.slug, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "saml.provider.deleted",
          resource: { type: "saml_provider", id },
          before: snapshot(existing),
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    invalidateSamlConfigCache();

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.saml-providers.id.route.error");
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
