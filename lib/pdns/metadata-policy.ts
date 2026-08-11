/**
 * lib/pdns/metadata-policy.ts
 *
 * Policy decisions about zone metadata that both the UI and the write path
 * must agree on. Kept here (not in the metadata tab's `kind-specs`) so the
 * route handler and the client render off ONE source of truth - a UI-only
 * "read-only" flag that the API doesn't enforce is a gap, not a guard.
 *
 * Two concerns live here:
 *
 *   1. Which kinds AuthAdmin refuses to WRITE. Verified against pdns-auth
 *      4.9.16: `PUT .../metadata/{kind}` returns 422 "Unsupported metadata
 *      kind" for each of these, so AuthAdmin refusing at the boundary just
 *      turns an ugly downstream 422 into a clear message - PowerDNS is the
 *      actual backstop, not this list.
 *
 *   2. Whether a zone has Lua records enabled. PowerDNS decides this from TWO
 *      independent signals (verified against 4.9.16 + the 4.9 docs):
 *        - the daemon-global `enable-lua-records` setting (no | yes | shared),
 *          exposed on `GET /servers/{id}/config`; and
 *        - the per-zone `ENABLE-LUA-RECORDS` domain metadata, which enables Lua
 *          for one zone "even if enable-lua-records is set to no".
 *      Either one arms Lua, so the record editor and the RRset write path gate
 *      on the OR of both - checking only the per-zone flag (as the original
 *      change did) blocks Lua on every server that enabled it globally, and on
 *      4.9 the per-zone flag can't even be set through the API, so that path is
 *      pdnsutil-only. The two reads live at the call sites (they need the
 *      client); the interpretation of each value lives here.
 *
 * Pure + dependency-light (only the error type), like `writable-kind.ts`, so
 * it's usable from server components, route handlers, and client code alike.
 */

import { ForbiddenError } from "@/lib/errors";
import type { PdnsMetadata } from "./types";

/** Per-zone domain-metadata key that opts a single zone into Lua records. */
export const ENABLE_LUA_RECORDS_KIND = "ENABLE-LUA-RECORDS";

/** Daemon-global config setting that enables Lua records fleet-wide. */
export const ENABLE_LUA_RECORDS_SETTING = "enable-lua-records";

/**
 * Metadata kinds AuthAdmin treats as read-only. Verified against pdns-auth
 * 4.9.16: every kind here answers `PUT .../metadata/{kind}` with 422. Most are
 * DNSSEC signing state or the AXFR TSIG bindings, which belong to the crypto /
 * pdnsutil surfaces; `ENABLE-LUA-RECORDS` is here because it arms server-side
 * code execution, so it must be a deliberate act on the PowerDNS host.
 *
 * `SOA-EDIT-API`, `API-RECTIFY`, and `SOA-EDIT` are also non-writable metadata,
 * but AuthAdmin surfaces those as zone-object fields elsewhere
 * (`ZONE_OBJECT_KINDS`), so they never reach this predicate.
 */
export const READ_ONLY_METADATA_KINDS: ReadonlySet<string> = new Set([
  "AXFR-MASTER-TSIG",
  "TSIG-ALLOW-AXFR",
  "LUA-AXFR-SCRIPT",
  "NSEC3NARROW",
  "NSEC3PARAM",
  "PRESIGNED",
  ENABLE_LUA_RECORDS_KIND,
]);

/**
 * Whether a metadata kind may be written through AuthAdmin. Custom
 * `X-`-prefixed kinds are always writable; explicitly read-only kinds are not;
 * anything else defaults to writable and lets PowerDNS have the final say.
 */
export function isApiWritableMetadataKind(kind: string): boolean {
  if (kind.startsWith("X-")) return true;
  return !READ_ONLY_METADATA_KINDS.has(kind);
}

/** Throw (403) when a write targets a read-only metadata kind. */
export function assertApiWritableMetadataKind(kind: string): void {
  if (!isApiWritableMetadataKind(kind)) {
    throw new ForbiddenError(
      `The "${kind}" metadata kind is read-only in AuthAdmin. ` +
        `Change it on the PowerDNS host (or via pdnsutil), not through the metadata API.`,
    );
  }
}

/**
 * Whether a zone's live metadata list opts it into Lua records. PowerDNS writes
 * the flag as `1`; we accept the same truthy spellings the metadata toggles use
 * so a hand-set `yes`/`true` on the host is honoured too. Reads only from the
 * metadata LIST endpoint, which is the only API surface that returns
 * `ENABLE-LUA-RECORDS` (the single-kind endpoint 422s it).
 */
export function isLuaEnabledByZoneMetadata(metadata: readonly PdnsMetadata[]): boolean {
  return metadata.some(
    (item) => item.kind === ENABLE_LUA_RECORDS_KIND && item.metadata.some(isTruthyFlag),
  );
}

/**
 * Whether the daemon-global `enable-lua-records` setting arms Lua records. Per
 * the 4.9 docs the value is one of `no` (default), `yes` (or empty), or
 * `shared`; the `shard` spelling from older releases is accepted as an alias.
 */
export function isLuaEnabledGlobally(settingValue: string | undefined | null): boolean {
  if (settingValue == null) return false;
  const v = settingValue.trim().toLowerCase();
  if (v === "") return true; // documented: empty is equivalent to `yes`
  return v === "shared" || v === "shard" || isTruthyFlag(v);
}

function isTruthyFlag(value: string): boolean {
  return /^(1|yes|true)$/i.test(value.trim());
}
