/**
 * lib/auth/providers/oidc-group-sync-pure.ts
 *
 * Pure helpers extracted from `oidc-group-sync.ts` so unit tests can
 * import them without dragging in `@/lib/db` (which pulls `pg` at module
 * load — vitest can't resolve pg's nested ESM/CJS dance under the
 * vite-conditions we use). See `oidc-group-sync.ts` for the DB-touching
 * applier.
 */

import type { OidcGroupMapping } from "@/lib/db/schema-sqlite/oidc-providers";

export type { OidcGroupMapping };

export interface ResolvedAssignment {
  roleId: string;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
  /** Original mapping that produced this — carried through for audit. */
  source: OidcGroupMapping;
}

export interface GroupSyncDiff {
  add: ResolvedAssignment[];
  remove: Array<{ id: string; roleId: string; scopeType: string; scopeId: string | null }>;
}

/**
 * Diff the target set (from group mappings) against the current set (from
 * provider-managed role assignments). Pure — exported for tests.
 *
 * Keys are `(roleId, scopeType, scopeId)` triples; equality is exact match.
 * A user picking up the same role at different scopes is two separate rows.
 */
export function diffGroupSync(
  target: ResolvedAssignment[],
  existing: Array<{ id: string; roleId: string; scopeType: string; scopeId: string | null }>,
): GroupSyncDiff {
  const key = (r: { roleId: string; scopeType: string; scopeId: string | null }) =>
    `${r.roleId}|${r.scopeType}|${r.scopeId ?? ""}`;

  const existingByKey = new Map(existing.map((row) => [key(row), row]));
  const targetByKey = new Map(target.map((row) => [key(row), row]));

  const add: ResolvedAssignment[] = [];
  for (const [k, t] of targetByKey) {
    if (!existingByKey.has(k)) add.push(t);
  }
  const remove: GroupSyncDiff["remove"] = [];
  for (const [k, e] of existingByKey) {
    if (!targetByKey.has(k)) remove.push(e);
  }
  return { add, remove };
}

/**
 * Pull a Set<string> of group names from an OIDC claim value. Accepts the
 * conventional string-array shape, falls back to space- or comma-separated
 * strings for IdPs that emit those, and ignores everything else.
 */
export function readGroupClaim(raw: unknown): Set<string> {
  if (Array.isArray(raw)) {
    return new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0));
  }
  if (typeof raw === "string" && raw.length > 0) {
    const split = raw.includes(",") ? raw.split(",") : raw.split(/\s+/);
    return new Set(split.map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return new Set();
}
