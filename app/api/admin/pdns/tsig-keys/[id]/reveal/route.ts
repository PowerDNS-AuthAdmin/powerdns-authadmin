/**
 * app/api/admin/pdns/tsig-keys/[id]/reveal/route.ts
 *
 * POST — redeem the single-use reveal token minted by the sibling
 *        TSIG create route and return the HMAC secret as
 *        `text/plain` exactly once. Mirrors S-8's reset-password
 *        reveal pattern: the secret never appears in a JSON
 *        response body that could be re-rendered by access loggers
 *        or browser dev tools.
 *
 * Permission: `tsig.manage` (the secret is the high-value bit, so
 * gate this on the management-tier permission even though no
 * mutation happens here).
 */

import { ZodError, z } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { redeem } from "@/lib/auth/temp-reveal-store";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({
  token: z.string().min(20).max(200),
});

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "tsig.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    let input;
    try {
      input = bodySchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid token.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const result = await redeem({ token: input.token, actorId: actor.id });
    if (!result) {
      await appendAudit({
        actor: { type: "user", id: actor.id },
        action: "tsig.reveal",
        resource: { type: "tsig", id: decodeURIComponent(id) },
        after: { revealAttempted: true, revealOutcome: "denied-or-expired" },
      });
      throw new NotFoundError("Token unknown, already used, or expired.");
    }

    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "tsig.reveal",
      resource: { type: "tsig", id: decodeURIComponent(id) },
      after: { revealAttempted: true, revealOutcome: "delivered" },
    });

    return new Response(result.plaintext, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof ValidationError)
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
