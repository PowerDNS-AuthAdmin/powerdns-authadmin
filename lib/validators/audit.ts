/**
 * lib/validators/audit.ts
 *
 * Parse audit-log query-string filters. The admin audit page receives these
 * via searchParams; the schema normalizes empty strings to undefined so the
 * UI's empty form fields don't accidentally filter to "".
 */

import "server-only";
import { z } from "zod";

const optionalString = z
  .string()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined));

/**
 * Accept either a bare date (`YYYY-MM-DD`, useful with
 * `<input type="date">`) or a full ISO datetime with offset. The page
 * code passes the value straight into `new Date(...)`, which handles
 * both — bare dates parse as 00:00 UTC, which matches operators'
 * default "day filter" mental model.
 */
// Bug fix: a prior `z.string().optional()` happily matches `""`, so the
// `.or(z.literal(""))` branch never ran and `.refine()` rejected the
// empty string. Coerce empty → undefined BEFORE validation so the
// "blank filter field" case stays a no-op.
const optionalDate = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z
    .string()
    .refine(
      (v) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v),
      { message: "Must be YYYY-MM-DD or a full ISO datetime." },
    )
    .optional(),
);

export const auditQuerySchema = z.object({
  actorId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  actorType: z
    .enum(["user", "token", "system"])
    .optional()
    .or(z.literal("").transform(() => undefined)),
  action: optionalString,
  resourceType: optionalString,
  resourceId: optionalString,
  // Bound roughly to the pattern set the middleware accepts: UUID,
  // ULID, KSUID, or any opaque [A-Za-z0-9_.:-] token. Keep the
  // schema permissive (1-200 chars, any non-empty string) since
  // upstream proxies may inject their own formats; the worst case
  // is an empty results page.
  requestId: optionalString,
  // Free-text search. Capped at 200 chars to keep the
  // generated SQL bounded; longer queries are almost certainly typos.
  q: z
    .string()
    .max(200)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  from: optionalDate,
  to: optionalDate,
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
