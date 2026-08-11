import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { assertZoneAllowsLua, luaDenialReasonForNewZone } from "./lua-enablement";
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
