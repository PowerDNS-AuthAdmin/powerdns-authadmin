/**
 * app/api/search/route.ts
 *
 * GET ?q=&scope=all|zones|records|config|requests|audit - the global search
 * palette's backend (and the MCP `search` tool's). Any signed-in user may
 * call it; what each user gets back is decided per source inside
 * `searchEverything`, so a user with no roles receives empty groups rather
 * than a 403. Rate-limited per user, never cached.
 */

import { z } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { searchLimiter } from "@/lib/auth/rate-limit";
import { RateLimitedError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { parseSearchParams } from "@/lib/http/parse-query";
import { SEARCH_SCOPES, searchEverything } from "@/lib/search";
import { optionalFeatures } from "@/lib/env";

export const dynamic = "force-dynamic";

const MAX_QUERY_LENGTH = 100;

const querySchema = z.object({
  q: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(MAX_QUERY_LENGTH)),
  scope: z.enum(SEARCH_SCOPES).default("all"),
  limit: z.coerce.number().int().min(1).max(25).optional(),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireUser();
    const limited = searchLimiter.take(`search:${auth.user.id}`);
    if (!limited.allowed) throw new RateLimitedError(limited.retryAfterSeconds);
    const { q, scope, limit } = parseSearchParams(querySchema, new URL(request.url));
    const result = await searchEverything({
      q,
      scope,
      limit,
      auth: {
        globalPermissions: auth.globalPermissions,
        zoneGrants: auth.zoneGrants,
        canReadTeam: (id) => auth.ability.can("read", { __type: "Team", id }),
        features: optionalFeatures,
      },
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (err) {
    const res = errorResponse(err, "search.route.error");
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
