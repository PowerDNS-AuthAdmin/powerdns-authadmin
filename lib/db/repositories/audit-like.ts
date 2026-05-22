/**
 * lib/db/repositories/audit-like.ts
 *
 * Pure ILIKE-pattern escaper used by the audit-log full-text filter.
 * Split out from `audit.ts` so unit tests can import it without
 * dragging in `pg` and `drizzle-orm`.
 *
 * Escape order matters: backslash MUST be escaped first, otherwise
 * the backslashes inserted by the % / _ escapes themselves get
 * escaped on a second pass.
 */

export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
