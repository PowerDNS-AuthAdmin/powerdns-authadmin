/**
 * app/api/admin/pdns/tsig-keys/route.ts
 *
 * POST — generate a TSIG key on the selected PDNS backend.
 *        Permission: `tsig.manage`. Response carries a one-time reveal
 *        token (the actual HMAC secret is held in the in-memory
 *        temp-reveal-store from S-8 and retrieved via the sibling
 *        `/reveal` endpoint as `text/plain`). The plaintext secret
 *        NEVER appears in the JSON body of this response — the same
 *        threat model as S-8's admin password reset.
 *
 * The PDNS-assigned `id` is returned so the UI can re-fetch the
 * inventory row immediately without a list refresh.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { mint } from "@/lib/auth/temp-reveal-store";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { errorResponse } from "@/lib/http/error-response";
import { NotFoundError, ValidationError } from "@/lib/errors";

const ALGORITHMS = [
  "hmac-md5",
  "hmac-sha1",
  "hmac-sha224",
  "hmac-sha256",
  "hmac-sha384",
  "hmac-sha512",
] as const;

const createSchema = z.object({
  serverSlug: z.string().optional(),
  // PDNS TSIG names are DNS labels; allow letters, digits, hyphens,
  // dots (operators often use FQDN-style names like "primary.example.").
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9.-]+$/, "Name must be letters, digits, dots, or hyphens."),
  algorithm: z.enum(ALGORITHMS).default("hmac-sha256"),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "tsig.manage" });
    await requireCsrf(request);

    let body;
    try {
      body = createSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const selected = body.serverSlug
      ? await findPdnsServerBySlug(body.serverSlug)
      : await findDefaultPdnsServer();
    if (selected?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }
    const client = getBackendGateway(selected);

    // The created detail carries the freshly generated secret in `key`.
    // We destructure it out before any audit / log / response path
    // touches the rest of the object — the audit redactor *also*
    // catches it, but destructuring is the primary defense.
    const created = await client.createTsigKey({
      name: body.name,
      algorithm: body.algorithm,
    });
    const { key: plaintextSecret, ...safeDetail } = created;

    // Mint a reveal token bound to this operator's user-id. The token
    // is single-use, actor-bound, and expires in 300s.
    const { token: revealToken, expiresInSec } = await mint({
      plaintext: plaintextSecret,
      allowedActorId: actor.id,
    });

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "tsig.create",
      resource: { type: "tsig", id: created.id },
      after: {
        // No `key` — the audit log persists name/algorithm/id only.
        ...safeDetail,
        revealTokenIssued: true,
        revealExpiresInSec: expiresInSec,
      },
      request: getRequestContext(hdrs),
    });

    return Response.json(
      {
        ok: true,
        tsigKey: safeDetail,
        revealToken,
        expiresInSec,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "pdns.tsig.route.error");
  }
}
