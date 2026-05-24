/**
 * app/api/profile/tokens/route.ts
 *
 * Self-service personal access token issuance.
 *
 * GET  — list the caller's own tokens (newest first).
 * POST — issue a new token. Permission: any authenticated user. The
 *        operator-supplied `scopes` array is clamped to the user's
 *        current effective permissions — operators can't grant a
 *        token a permission they don't themselves hold (which would
 *        defeat scope-narrowing on the auth path).
 *
 * The freshly-generated plaintext is never returned in the JSON body
 * — same temp-reveal-store pattern as S-8 / TSIG. The POST response
 * carries a one-time reveal token; the operator's browser POSTs it
 * to `/tokens/[id]/reveal` to get the plaintext as text/plain
 * exactly once.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { mint } from "@/lib/auth/temp-reveal-store";
import { generateToken } from "@/lib/auth/tokens";
import { db } from "@/lib/db";
import { insertApiToken, listApiTokensForUser } from "@/lib/db/repositories/api-tokens";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const PERMISSION_SET = new Set<string>(PERMISSIONS);

const createSchema = z.object({
  name: z.string().min(1).max(80),
  /**
   * Permission scopes. Empty array means "inherit everything the user
   * currently has at token-use time" (back-compat with the existing
   * `narrowAssignmentsByTokenScopes` empty-scopes semantics). Any
   * non-empty list is intersected with the user's actual effective
   * permissions; values outside the master vocabulary are rejected.
   */
  scopes: z
    .array(z.string())
    .max(64)
    .refine(
      (list) => list.every((p) => PERMISSION_SET.has(p)),
      "Scopes list contains values outside the master vocabulary.",
    ),
  /** Optional expiry in ISO-8601. Past dates are rejected. */
  expiresAt: z
    .string()
    .datetime()
    .optional()
    .refine((s) => !s || new Date(s).getTime() > Date.now(), "Expiry must be in the future."),
});

export async function GET(): Promise<Response> {
  try {
    const { user } = await requireUser();
    const rows = await listApiTokensForUser(user.id);
    // Strip tokenHash — it's an Argon2 hash but exposing it serves no
    // legitimate purpose and could feed offline cracking. Strip
    // lastUsedIp from the payload too; we display "last used N ago"
    // not the IP itself in the UI.
    return Response.json({
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: r.scopes,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err, "profile.tokens.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

    let input;
    try {
      input = createSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    // Clamp scopes to the user's effective permissions. A user who
    // doesn't currently hold `zone.delete` cannot mint a token with
    // `zone.delete` in its scopes — defeating that would be a
    // privilege-escalation oracle.
    const effective = new Set<string>();
    const assignments = await loadUserAssignmentsForAbility(user.id);
    for (const a of assignments) {
      for (const p of a.permissions) effective.add(p);
    }
    const requestedOutsideUserScope = input.scopes.filter((p) => !effective.has(p));
    if (requestedOutsideUserScope.length > 0) {
      throw new ForbiddenError(
        `Cannot grant token scopes you don't hold yourself: ${requestedOutsideUserScope.join(", ")}.`,
      );
    }

    const material = await generateToken();

    // Minted before the tx so its `expiresInSec` can ride the audit snapshot;
    // if the tx rolls back the unused reveal token expires on its own and
    // reveals a plaintext that was never persisted (so it can't authenticate).
    const { token: revealToken, expiresInSec } = await mint({
      plaintext: material.plaintext,
      allowedActorId: user.id,
    });

    const hdrs = await headers();
    const tokenRow = await db.transaction(async (tx) => {
      const row = await insertApiToken(
        {
          userId: user.id,
          name: input.name.trim(),
          tokenHash: material.hash,
          prefix: material.prefix,
          scopes: input.scopes,
          teamId: null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.token.issued",
          resource: { type: "api-token", id: row.id },
          after: {
            name: row.name,
            prefix: row.prefix,
            scopes: row.scopes,
            expiresAt: row.expiresAt?.toISOString() ?? null,
            revealTokenIssued: true,
            revealExpiresInSec: expiresInSec,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return row;
    });

    return Response.json(
      {
        ok: true,
        token: {
          id: tokenRow.id,
          name: tokenRow.name,
          prefix: tokenRow.prefix,
          scopes: tokenRow.scopes,
          expiresAt: tokenRow.expiresAt?.toISOString() ?? null,
          createdAt: tokenRow.createdAt.toISOString(),
        },
        revealToken,
        expiresInSec,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "profile.tokens.route.error");
  }
}
