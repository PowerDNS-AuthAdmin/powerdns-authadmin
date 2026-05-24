/**
 * app/api/admin/users/[id]/reset-password/reveal/route.ts
 *
 * POST — redeem a single-use reveal token issued by the sibling
 * reset-password POST and return the plaintext as `text/plain` exactly
 * once. See `lib/auth/temp-reveal-store.ts` for the store semantics
 * (single-use deletion, actor binding, TTL).
 *
 * The body is `application/json` because the call comes from our admin UI
 * via `apiFetch` which auto-adds the CSRF header. The response body is
 * `text/plain; charset=utf-8` so the UI receives just the password with no
 * surrounding JSON shape that could later be re-rendered in logs or dev
 * tools as structured data.
 *
 * The `[id]` path segment is decorative — it has to match a user-id-shaped
 * value but the actual user-mapping lives inside the reveal-store entry,
 * keyed by the token. We still call `requireUser({ can: "user.reset-password" })`
 * so an operator who lost that permission between the POST and this call
 * can't redeem.
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
    const { user: actor } = await requireUser({ can: "user.reset-password" });
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
      // Audit the failed/late reveal so a leaked-token redemption attempt is
      // visible even though it returned nothing. Don't include the token
      // value — useless once redeemed and pointless to retain.
      await appendAudit({
        actor: { type: "user", id: actor.id },
        action: "user.password.reset",
        resource: { type: "user", id },
        after: { revealAttempted: true, revealOutcome: "denied-or-expired" },
      });
      throw new NotFoundError("Token unknown, already used, or expired.");
    }

    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "user.password.reset",
      resource: { type: "user", id },
      after: { revealAttempted: true, revealOutcome: "delivered" },
    });

    return new Response(result.plaintext, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        // Hint to intermediaries that this is sensitive opaque material.
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
