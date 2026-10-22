import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import {
  assertLuaRecordsMutable,
  assertZoneAllowsLua,
  luaDenialReasonForNewZone,
} from "./lua-enablement";
import type { PdnsClient } from "./client";
import { PdnsError } from "./errors";
import type { PdnsConfigSetting, PdnsMetadata } from "./types";

/**
 * The gate only ever calls these two reads, so a stub carrying them is enough.
 * `throw` values stand in for a backend that can't be reached.
 */
function fakeClient(opts: {
  config?: PdnsConfigSetting[] | Error;
  metadata?: PdnsMetadata[] | Error;
}): PdnsClient {
  const answer = <T>(value: T | Error | undefined): Promise<T> => {
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve((value ?? []) as T);
  };
  return {
    getConfig: () => answer<PdnsConfigSetting[]>(opts.config),
    listZoneMetadata: () => answer<PdnsMetadata[]>(opts.metadata),
  } as unknown as PdnsClient;
}

const setting = (value: string): PdnsConfigSetting[] => [
  { type: "ConfigSetting", name: "enable-lua-records", value },
];

/** A PDNS 5.1+ `/config`: Lua armed, with the record-updates lock as given. */
const pdns51 = (updates: string): PdnsConfigSetting[] => [
  ...setting("yes"),
  { type: "ConfigSetting", name: "enable-lua-record-updates", value: updates },
];

const unreachable = new PdnsError("connect ECONNREFUSED", { status: 502 });

describe("assertZoneAllowsLua", () => {
  it("allows the write when the zone carries ENABLE-LUA-RECORDS metadata", async () => {
    const client = fakeClient({
      metadata: [{ kind: "ENABLE-LUA-RECORDS", metadata: ["1"] }],
      config: setting("no"),
    });
    await expect(assertZoneAllowsLua(client, "example.com.")).resolves.toBeUndefined();
  });

  it("allows the write when Lua is armed daemon-wide", async () => {
    const client = fakeClient({ metadata: [], config: setting("yes") });
    await expect(assertZoneAllowsLua(client, "example.com.")).resolves.toBeUndefined();
  });

  it("refuses when neither signal arms Lua", async () => {
    const client = fakeClient({ metadata: [], config: setting("no") });
    await expect(assertZoneAllowsLua(client, "example.com.")).rejects.toThrow(ValidationError);
    await expect(assertZoneAllowsLua(client, "example.com.")).rejects.toThrow(
      /not enabled for this zone/,
    );
  });

  it("fails closed when the metadata read fails", async () => {
    const client = fakeClient({ metadata: unreachable, config: setting("yes") });
    await expect(assertZoneAllowsLua(client, "example.com.")).rejects.toThrow(
      /Could not verify Lua-records enablement/,
    );
  });

  it("fails closed when the config read fails", async () => {
    const client = fakeClient({ metadata: [], config: unreachable });
    await expect(assertZoneAllowsLua(client, "example.com.")).rejects.toThrow(
      /Could not verify Lua-records enablement/,
    );
  });
});

describe("luaDenialReasonForNewZone", () => {
  it("allows the import when Lua is armed daemon-wide", async () => {
    await expect(luaDenialReasonForNewZone(fakeClient({ config: setting("yes") }))).resolves.toBe(
      null,
    );
  });

  it("allows the import on a shared-Lua daemon", async () => {
    await expect(
      luaDenialReasonForNewZone(fakeClient({ config: setting("shared") })),
    ).resolves.toBe(null);
  });

  it("refuses the import when Lua is off", async () => {
    await expect(luaDenialReasonForNewZone(fakeClient({ config: setting("no") }))).resolves.toMatch(
      /not enabled on this PowerDNS backend/,
    );
  });

  it("refuses the import when enable-lua-records is absent entirely", async () => {
    await expect(luaDenialReasonForNewZone(fakeClient({ config: [] }))).resolves.toMatch(
      /not enabled on this PowerDNS backend/,
    );
  });

  it("fails closed when the config read fails", async () => {
    await expect(luaDenialReasonForNewZone(fakeClient({ config: unreachable }))).resolves.toMatch(
      /Could not verify Lua-records enablement/,
    );
  });

  it("never consults zone metadata - the zone does not exist yet", async () => {
    // A metadata read would 404 on a zone being created and deny an import
    // the operator is entitled to make.
    const client = fakeClient({
      config: setting("yes"),
      metadata: new Error("listZoneMetadata must not be called"),
    });
    await expect(luaDenialReasonForNewZone(client)).resolves.toBe(null);
  });
});

// PowerDNS 5.1 makes LUA records immutable unless enable-lua-record-updates is
// on - verified on 5.1.5, creates, edits and deletes all 422 with Lua armed.
describe("PowerDNS 5.1 enable-lua-record-updates lock", () => {
  it("refuses an upsert on a locked daemon even with Lua armed", async () => {
    const client = fakeClient({ metadata: [], config: pdns51("no") });
    await expect(assertZoneAllowsLua(client, "example.com.")).rejects.toThrow(
      /enable-lua-record-updates=yes/,
    );
  });

  it("refuses an upsert on a locked daemon even with zone metadata arming Lua", async () => {
    const client = fakeClient({
      metadata: [{ kind: "ENABLE-LUA-RECORDS", metadata: ["1"] }],
      config: pdns51("no"),
    });
    await expect(assertZoneAllowsLua(client, "example.com.")).rejects.toThrow(
      /enable-lua-record-updates=yes/,
    );
  });

  it("reports Lua being off before the lock - that's the setting to fix first", async () => {
    const client = fakeClient({
      metadata: [],
      config: [
        ...setting("no"),
        { type: "ConfigSetting", name: "enable-lua-record-updates", value: "no" },
      ],
    });
    await expect(assertZoneAllowsLua(client, "example.com.")).rejects.toThrow(
      /not enabled for this zone/,
    );
  });

  it("allows an upsert once updates are unlocked", async () => {
    const client = fakeClient({ metadata: [], config: pdns51("yes") });
    await expect(assertZoneAllowsLua(client, "example.com.")).resolves.toBeUndefined();
  });

  it.each(["on", "1", "true", "yes"])("reads %s as unlocked, as PowerDNS does", async (value) => {
    await expect(
      assertLuaRecordsMutable(fakeClient({ config: pdns51(value) })),
    ).resolves.toBeUndefined();
  });

  it.each(["no", "off", "OFF"])("reads %s as locked", async (value) => {
    await expect(assertLuaRecordsMutable(fakeClient({ config: pdns51(value) }))).rejects.toThrow(
      ValidationError,
    );
  });

  it("allows a delete on a pre-5.1 daemon, which reports no lock", async () => {
    await expect(
      assertLuaRecordsMutable(fakeClient({ config: setting("no") })),
    ).resolves.toBeUndefined();
  });

  it("allows a delete without Lua armed - removing Lua needs no enablement", async () => {
    const client = fakeClient({
      config: [{ type: "ConfigSetting", name: "enable-lua-record-updates", value: "yes" }],
    });
    await expect(assertLuaRecordsMutable(client)).resolves.toBeUndefined();
  });

  it("fails a delete closed when the config read fails", async () => {
    await expect(assertLuaRecordsMutable(fakeClient({ config: unreachable }))).rejects.toThrow(
      /Could not verify Lua-records enablement/,
    );
  });

  it("refuses an import into a locked daemon", async () => {
    await expect(luaDenialReasonForNewZone(fakeClient({ config: pdns51("no") }))).resolves.toMatch(
      /enable-lua-record-updates=yes/,
    );
  });

  it("allows an import once updates are unlocked", async () => {
    await expect(luaDenialReasonForNewZone(fakeClient({ config: pdns51("yes") }))).resolves.toBe(
      null,
    );
  });
});
