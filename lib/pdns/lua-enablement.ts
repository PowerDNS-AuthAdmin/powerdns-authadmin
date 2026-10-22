/**
 * lib/pdns/lua-enablement.ts
 *
 * The live check that gates writing a LUA record. LUA rdata executes inside
 * the authoritative server, so AuthAdmin refuses to create one unless
 * PowerDNS actually has Lua armed - either the daemon-global
 * `enable-lua-records` setting or the per-zone `ENABLE-LUA-RECORDS` metadata
 * (`metadata-policy.ts` explains why it is the OR of both).
 *
 * PowerDNS 5.1+ adds a separate lock, `enable-lua-record-updates`, that makes
 * every LUA change (create, edit, delete) 422 even with Lua armed. It is
 * checked here too, for deletes as well as upserts, so the operator is told
 * which setting to flip instead of getting PowerDNS's bare refusal back.
 *
 * Every read happens here rather than trusting anything the client sent, so a
 * crafted request or a stale tab can't talk a disabled server into accepting
 * Lua. Any read failure denies the write: an unverifiable backend is treated
 * as a disabled one.
 *
 * This lives in `lib/pdns/` rather than beside one route because there are two
 * write paths into the same daemon - the RRset PATCH and the zonefile import -
 * and a gate that only one of them applies is not a gate.
 */

import { ValidationError } from "@/lib/errors";
import { redact } from "@/lib/errors/redact";
import type { PdnsClient } from "./client";
import { PdnsError } from "./errors";
import {
  areLuaRecordUpdatesLocked,
  ENABLE_LUA_RECORD_UPDATES_SETTING,
  ENABLE_LUA_RECORDS_SETTING,
  isLuaEnabledByZoneMetadata,
  isLuaEnabledGlobally,
} from "./metadata-policy";

const NOT_ENABLED_FOR_ZONE =
  "LUA records are not enabled for this zone. Enable them on the PowerDNS host - set " +
  "enable-lua-records globally, or the ENABLE-LUA-RECORDS metadata on this zone via pdnsutil.";

const NOT_ENABLED_ON_BACKEND =
  "LUA records are not enabled on this PowerDNS backend. Set enable-lua-records on the host " +
  "before importing a zonefile that contains LUA records.";

const UPDATES_LOCKED =
  "This PowerDNS backend does not allow changes to LUA records. PowerDNS 5.1+ makes them " +
  "read-only unless enable-lua-record-updates=yes is set on the host.";

interface GlobalLuaState {
  enabled: boolean;
  /** `enable-lua-record-updates` is reported and off (PDNS 5.1+). */
  updatesLocked: boolean;
  /** Set when the config read failed - carries the operator-facing reason. */
  unreadable: string | null;
}

async function readGlobalLua(client: PdnsClient): Promise<GlobalLuaState> {
  try {
    const config = await client.getConfig();
    const valueOf = (name: string) => config.find((row) => row.name === name)?.value;
    return {
      enabled: isLuaEnabledGlobally(valueOf(ENABLE_LUA_RECORDS_SETTING)),
      updatesLocked: areLuaRecordUpdatesLocked(valueOf(ENABLE_LUA_RECORD_UPDATES_SETTING)),
      unreadable: null,
    };
  } catch (err) {
    if (err instanceof PdnsError) {
      return {
        enabled: false,
        updatesLocked: true,
        unreadable: `Could not verify Lua-records enablement: ${redact(err.message)}`,
      };
    }
    throw err;
  }
}

/**
 * Gate a LUA upsert against an EXISTING zone. Lua must be armed (zone metadata
 * or daemon-wide) and LUA records must be mutable on this daemon.
 */
export async function assertZoneAllowsLua(client: PdnsClient, zoneName: string): Promise<void> {
  let metadata;
  try {
    metadata = await client.listZoneMetadata(zoneName);
  } catch (err) {
    if (err instanceof PdnsError) {
      throw new ValidationError(`Could not verify Lua-records enablement: ${redact(err.message)}`);
    }
    throw err;
  }

  const global = await readGlobalLua(client);
  if (global.unreadable) throw new ValidationError(global.unreadable);
  if (!isLuaEnabledByZoneMetadata(metadata) && !global.enabled) {
    throw new ValidationError(NOT_ENABLED_FOR_ZONE);
  }
  if (global.updatesLocked) throw new ValidationError(UPDATES_LOCKED);
}

/**
 * Gate a LUA delete. Removing executable rdata needs no Lua enablement - only
 * the 5.1+ immutability lock can refuse it.
 */
export async function assertLuaRecordsMutable(client: PdnsClient): Promise<void> {
  const global = await readGlobalLua(client);
  if (global.unreadable) throw new ValidationError(global.unreadable);
  if (global.updatesLocked) throw new ValidationError(UPDATES_LOCKED);
}

/**
 * Gate a LUA write against a zone that does NOT exist yet (zonefile import).
 * Only the daemon-global setting can apply - there is no zone to carry
 * `ENABLE-LUA-RECORDS` metadata, and reading metadata for a name PowerDNS has
 * never heard of would 404 and deny an import the operator is entitled to.
 *
 * Returns null when the write may proceed, otherwise the reason to refuse.
 * Deliberately does not throw for a refusal: import is best-effort per zone,
 * so the caller records this as one zone's failure instead of aborting a run
 * whose other zones are fine.
 */
export async function luaDenialReasonForNewZone(client: PdnsClient): Promise<string | null> {
  const global = await readGlobalLua(client);
  if (global.unreadable) return global.unreadable;
  if (!global.enabled) return NOT_ENABLED_ON_BACKEND;
  return global.updatesLocked ? UPDATES_LOCKED : null;
}
