/**
 * lib/auth/providers/group-sync-pure.ts
 *
 * Pure (DB-free) helpers for IdP group → role mapping. Used by every
 * provider type — OIDC, SAML, LDAP — because the mapping shape is
 * identical across them. The protocol-specific code stays in each
 * provider's own module (`oidc.ts`, `saml.ts`, `ldap.ts`); resolving
 * mappings to permissions is shared from here.
 *
 * Why this module exists separately from `group-sync.ts`: vitest can't
 * resolve `pg`'s nested ESM/CJS dance under the vite-conditions we use,
 * so the DB-touching applier lives in `group-sync.ts` and the pure
 * helpers live here so unit tests can import them without `lib/db` in
 * the path.
 */

/**
 * One row of an IdP's `group_mappings` JSON column. Structurally
 * identical across `oidc_providers`, `saml_providers`, and
 * `ldap_providers` — define a neutral shape here so the sync code
 * doesn't lean on any specific protocol's schema type.
 *
 * The per-table types (`OidcGroupMapping`, `SamlGroupMapping`,
 * `LdapGroupMapping`) are kept as aliases inside each provider's
 * schema module for clarity at the column declaration; consumers
 * crossing provider types use `GroupMapping`.
 */
export interface GroupMapping {
  /** IdP-side group name as it appears in the user's claim. */
  group: string;
  /** Local role slug to grant when this group is present. */
  roleSlug: string;
  /** Scope the role is granted at. */
  scopeType: "global" | "team" | "zone" | "server";
  /** Scope id when applicable (team/server uuid, zone name, …); null at global scope. */
  scopeId: string | null;
}

export interface ResolvedAssignment {
  roleId: string;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
  /** Original mapping that produced this — carried through for audit. */
  source: GroupMapping;
}

export interface GroupSyncDiff {
  add: ResolvedAssignment[];
  remove: Array<{ id: string; roleId: string; scopeType: string; scopeId: string | null }>;
}

/**
 * Diff the target set (from group mappings) against the current set (from
 * provider-managed role assignments). Pure — exported for tests.
 *
 * Not used at runtime today — IdP-derived permissions live on
 * `sessions.derived_permissions` and don't persist on the user, so there's
 * no row set to diff against. Kept here as a building block for any future
 * "live session refresh" path that needs the same shape.
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
 * Pull a Set<string> of group names from an IdP claim value. Accepts the
 * conventional string-array shape (OIDC / LDAP `memberOf` / SAML attribute
 * array), falls back to space- or comma-separated strings for IdPs that
 * emit those, and ignores everything else.
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
