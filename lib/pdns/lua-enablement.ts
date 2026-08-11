/**
 * lib/pdns/lua-enablement.ts
 *
 * The live check that gates writing a LUA record. LUA rdata executes inside
 * the authoritative server, so AuthAdmin refuses to create one unless
 * PowerDNS actually has Lua armed - either the daemon-global
 * `enable-lua-records` setting or the per-zone `ENABLE-LUA-RECORDS` metadata
 * (`metadata-policy.ts` explains why it is the OR of both).
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

interface GlobalLuaState {
  enabled: boolean;
  /** Set when the config read failed - carries the operator-facing reason. */
  unreadable: string | null;
}

async function readGlobalLua(client: PdnsClient): Promise<GlobalLuaState> {
  try {
    const config = await client.getConfig();
    const setting = config.find((row) => row.name === ENABLE_LUA_RECORDS_SETTING)?.value;
    return { enabled: isLuaEnabledGlobally(setting), unreadable: null };
  } catch (err) {
    if (err instanceof PdnsError) {
      return {
        enabled: false,
        unreadable: `Could not verify Lua-records enablement: ${redact(err.message)}`,
      };
    }
    throw err;
  }
}

/**
 * Gate a LUA write against an EXISTING zone. The per-zone metadata read
 * short-circuits the config read, since either signal arms Lua.
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
  if (isLuaEnabledByZoneMetadata(metadata)) return;

  const global = await readGlobalLua(client);
  if (global.unreadable) throw new ValidationError(global.unreadable);
  if (global.enabled) return;

  throw new ValidationError(NOT_ENABLED_FOR_ZONE);
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
  return global.enabled ? null : NOT_ENABLED_ON_BACKEND;
}
