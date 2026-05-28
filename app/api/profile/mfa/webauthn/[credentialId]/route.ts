/**
 * app/api/profile/mfa/webauthn/[credentialId]/route.ts
 *
 * DELETE — remove ONE passkey credential from the signed-in user's account.
 * Selective (not blanket): a user with three passkeys can drop the lost
 * one and keep the others. Mirrors the per-row admin reset.
 *
 * PATCH — rename the credential (nickname only). Useful when a user enrolls
 * "Touch ID" then later wants to call it "MacBook Pro 14".
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import {
  findCredentialById,
  removeCredential,
  renameCredential,
} from "@/lib/db/repositories/webauthn";
import { env } from "@/lib/env";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { credentialRenameSchema } from "@/lib/validators/webauthn";

interface RouteContext {
  params: Promise<{ credentialId: string }>;
}

export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    if (!env.WEBAUTHN_ENABLED) {
      throw new ForbiddenError("WebAuthn is disabled by configuration.");
    }

    const { user } = await requireUser({ skipComplianceGate: true });
    await requireCsrf(request);
    const { credentialId } = await ctx.params;

    const existing = await findCredentialById(user.id, credentialId);
    if (!existing) throw new NotFoundError("Credential not found on this account.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await removeCredential(user.id, credentialId, tx);
      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.mfa.webauthn.removed",
          resource: { type: "user", id: user.id },
          before: {
            credentialId: existing.id,
            nickname: existing.nickname,
            transports: existing.transports ?? [],
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "profile.mfa.webauthn.credentialId.delete.error");
  }
}

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    if (!env.WEBAUTHN_ENABLED) {
      throw new ForbiddenError("WebAuthn is disabled by configuration.");
    }

    const { user } = await requireUser({ skipComplianceGate: true });
    await requireCsrf(request);
    const { credentialId } = await ctx.params;

    let input;
    try {
      input = credentialRenameSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const existing = await findCredentialById(user.id, credentialId);
    if (!existing) throw new NotFoundError("Credential not found on this account.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await renameCredential(user.id, credentialId, input.nickname, tx);
      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.mfa.webauthn.renamed",
          resource: { type: "user", id: user.id },
          before: { credentialId, nickname: existing.nickname },
          after: { credentialId, nickname: input.nickname },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "profile.mfa.webauthn.credentialId.patch.error");
  }
}
