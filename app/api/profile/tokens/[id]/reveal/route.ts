/**
 * app/api/profile/tokens/[id]/reveal/route.ts
 *
 * POST — redeem the one-time reveal token minted by the sibling
 *        tokens issuance endpoint. Returns the plaintext PAT as
 *        `text/plain` exactly once. Same temp-reveal-store pattern
 *        as S-8 + TSIG: the plaintext never appears in any JSON
 *        response body.
 *
 * Permission: any authenticated user. The reveal-store entry is
 * already bound to the minting user-id, so even a leaked reveal
 * token cannot be redeemed by a different operator.
 */

import { ZodError, z } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { redeem } from "@/lib/auth/temp-reveal-store";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

const bodySchema = z.object({
  token: z.string().min(20).max(200),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

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

    const result = await redeem({ token: input.token, actorId: user.id });
    if (!result) {
      throw new NotFoundError("Token unknown, already used, or expired.");
    }

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
