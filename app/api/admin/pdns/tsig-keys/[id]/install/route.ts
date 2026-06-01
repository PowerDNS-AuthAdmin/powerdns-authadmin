/**
 * app/api/admin/pdns/tsig-keys/[id]/install/route.ts
 *
 * POST - replicate this TSIG key (by id, on the primary given by `serverSlug`)
 *        onto the primary's secondaries via their TSIG API. The secret is
 *        fetched server-side and POSTed to each secondary - it NEVER reaches the
 *        browser. Per-backend version-gated (`supportsTsigApi`); older daemons
 *        report `unsupported` and the UI shows the manual pdnsutil path instead.
 *        Conflicts (same name, different secret) are reported, not overwritten.
 *
 * Permission: `tsig.manage` (replicating a secret is a management-tier op).
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { replicateKeyToSecondaries } from "@/lib/realtime/tsig-replication";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { errorResponse } from "@/lib/http/error-response";

const bodySchema = z.object({ serverSlug: z.string().optional() });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "tsig.manage" });
    await requireCsrf(request);
    const { id } = await context.params;
    const keyId = decodeURIComponent(id);

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json().catch(() => ({})));
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      }
      throw err;
    }

    const primary = body.serverSlug
      ? await findPdnsServerBySlug(body.serverSlug)
      : await findDefaultPdnsServer();
    if (primary?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }

    let result;
    try {
      result = await replicateKeyToSecondaries(primary, keyId);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) {
        throw new NotFoundError("TSIG key not found on the primary.");
      }
      throw err;
    }

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "tsig.install-secondaries",
      resource: { type: "tsig", id: `${primary.slug}:${keyId}` },
      // No secret in the audit row - just per-secondary outcomes.
      after: {
        keyName: result.keyName,
        results: result.results.map((r) => ({ server: r.serverSlug, outcome: r.outcome })),
      },
      request: getRequestContext(hdrs),
    });

    return Response.json(
      { ok: true, keyName: result.keyName, algorithm: result.algorithm, results: result.results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "pdns.tsig.install.error");
  }
}
