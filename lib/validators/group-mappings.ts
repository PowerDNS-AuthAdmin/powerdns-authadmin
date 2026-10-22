/**
 * lib/validators/group-mappings.ts
 *
 * IdP group → role mapping rows, shared by the OIDC, SAML and LDAP provider
 * validators and their admin forms. Pure, no server imports - the forms run
 * `prepareGroupMappings` before submit and the routes re-validate with
 * `groupMappingsSchema`, so both sides agree on what a usable row is.
 */

import { z } from "zod";
import { canonicalZoneName } from "@/lib/dns/zone-name";

export type MappingScopeType = "global" | "team" | "zone" | "server";

export interface GroupMappingRow {
  group: string;
  roleSlug: string;
  scopeType: MappingScopeType;
  scopeId: string | null;
}

/** Canonical zone name: LDH (plus `_`) labels of 1-63 octets, at most 253 octets plus the root dot. */
const ZONE_NAME_RE = /^(?=.{1,254}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+$/;

export function isValidZoneScope(name: string): boolean {
  return ZONE_NAME_RE.test(name);
}

/**
 * One mapping row. Zone targets are canonicalised (lowercase, trailing dot)
 * so a mapping matches however the operator typed it; team/server targets
 * keep the slug the form sends (resolved to an id at sign-in).
 */
export function groupMappingSchema(maxGroupLength: number) {
  return z
    .object({
      group: z.string().min(1).max(maxGroupLength),
      roleSlug: z.string().min(1).max(64),
      scopeType: z.enum(["global", "team", "zone", "server"]),
      /** Null when scopeType=global; slug or zone name otherwise. */
      scopeId: z.string().trim().min(1).max(255).nullable(),
    })
    .refine((m) => (m.scopeType === "global" ? m.scopeId === null : m.scopeId !== null), {
      message: "scopeId must be null for global scope and non-null for team/zone/server scope.",
    })
    .transform((m) =>
      m.scopeType === "zone" && m.scopeId !== null
        ? { ...m, scopeId: canonicalZoneName(m.scopeId) }
        : m,
    )
    .refine((m) => m.scopeType !== "zone" || isValidZoneScope(m.scopeId ?? ""), {
      message: "A zone target must be a zone name, e.g. example.com.",
    });
}

export function groupMappingsSchema(maxGroupLength: number) {
  return z.array(groupMappingSchema(maxGroupLength)).max(200).nullable();
}

export interface PreparedGroupMappings {
  mappings: GroupMappingRow[];
  /** One message per unusable row, numbered as the form shows them (1-based). */
  problems: string[];
}

/**
 * Clean the form's rows for submit. A row left completely empty (no group,
 * no target) is an unused placeholder and is dropped; a row with anything
 * filled in must be complete, otherwise it is reported instead of being
 * silently discarded - the operator would believe the mapping exists.
 */
export function prepareGroupMappings(rows: readonly GroupMappingRow[]): PreparedGroupMappings {
  const mappings: GroupMappingRow[] = [];
  const problems: string[] = [];
  rows.forEach((row, index) => {
    const group = row.group.trim();
    const roleSlug = row.roleSlug.trim();
    const target = row.scopeType === "global" ? "" : (row.scopeId ?? "").trim();
    if (group === "" && target === "") return;

    const missing: string[] = [];
    if (group === "") missing.push("an IdP group");
    if (roleSlug === "") missing.push("a role");
    if (row.scopeType !== "global" && target === "") missing.push(`a target ${row.scopeType}`);
    if (missing.length > 0) {
      problems.push(`Mapping ${index + 1} needs ${missing.join(" and ")}.`);
      return;
    }

    let scopeId: string | null = row.scopeType === "global" ? null : target;
    if (row.scopeType === "zone") {
      scopeId = canonicalZoneName(target);
      if (!isValidZoneScope(scopeId)) {
        problems.push(`Mapping ${index + 1}: "${target}" is not a zone name.`);
        return;
      }
    }
    mappings.push({ group, roleSlug, scopeType: row.scopeType, scopeId });
  });
  return { mappings, problems };
}

/**
 * Zone targets of `mappings` that name no zone in `knownZones` (canonical
 * names). `null` means the zone set is not fully known, and nothing is
 * reported - a warning must never fire because a backend was unreachable.
 */
export function unknownZoneTargets(
  mappings: ReadonlyArray<Pick<GroupMappingRow, "scopeType" | "scopeId">>,
  knownZones: ReadonlySet<string> | null,
): string[] {
  if (knownZones === null) return [];
  const out = new Set<string>();
  for (const m of mappings) {
    if (m.scopeType !== "zone" || m.scopeId === null) continue;
    const name = canonicalZoneName(m.scopeId);
    if (!knownZones.has(name)) out.add(name);
  }
  return [...out].sort();
}
