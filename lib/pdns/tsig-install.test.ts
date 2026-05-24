import { describe, expect, it } from "vitest";
import { installKeyOnBackend, tsigManualCommands, type TsigInstallClient } from "./tsig-install";

interface StoredKey {
  id: string;
  name: string;
  algorithm: string;
  key: string;
}
interface Created {
  name: string;
  algorithm: string;
  key: string;
}

function fakeClient(existing: StoredKey[]): TsigInstallClient & { created: Created[] } {
  const created: Created[] = [];
  return {
    created,
    listTsigKeys: () =>
      Promise.resolve(existing.map((k) => ({ id: k.id, name: k.name, algorithm: k.algorithm }))),
    getTsigKey: (id: string) => {
      const k = existing.find((e) => e.id === id);
      return k ? Promise.resolve(k) : Promise.reject(new Error(`no key ${id}`));
    },
    createTsigKey: (input: Created) => {
      created.push(input);
      return Promise.resolve(undefined);
    },
  };
}

const KEY = { name: "p2s", algorithm: "hmac-sha256", secret: "QUJDREVG" };

describe("installKeyOnBackend", () => {
  it("creates the key when the secondary doesn't have it", async () => {
    const client = fakeClient([]);
    expect(await installKeyOnBackend(client, KEY)).toBe("created");
    expect(client.created).toEqual([{ name: "p2s", algorithm: "hmac-sha256", key: "QUJDREVG" }]);
  });

  it("is a no-op when the secondary already has the identical key", async () => {
    const client = fakeClient([
      { id: "p2s.", name: "p2s", algorithm: "hmac-sha256", key: "QUJDREVG" },
    ]);
    expect(await installKeyOnBackend(client, KEY)).toBe("unchanged");
    expect(client.created).toEqual([]);
  });

  it("reports a conflict (no overwrite) when a same-named key has a different secret", async () => {
    const client = fakeClient([
      { id: "p2s.", name: "p2s", algorithm: "hmac-sha256", key: "ZZZdifferent" },
    ]);
    expect(await installKeyOnBackend(client, KEY)).toBe("conflict");
    expect(client.created).toEqual([]); // never overwrites
  });

  it("treats a same-secret-but-different-algorithm key as a conflict", async () => {
    const client = fakeClient([
      { id: "p2s.", name: "p2s", algorithm: "hmac-sha512", key: "QUJDREVG" },
    ]);
    expect(await installKeyOnBackend(client, KEY)).toBe("conflict");
  });

  it("matches the existing key by NAME, not by id", async () => {
    // id differs from name — we must still find it and not double-create.
    const client = fakeClient([
      { id: "internal-id-7", name: "p2s", algorithm: "hmac-sha256", key: "QUJDREVG" },
    ]);
    expect(await installKeyOnBackend(client, KEY)).toBe("unchanged");
  });
});

describe("tsigManualCommands", () => {
  it("emits legacy (4.x) pdnsutil import + activate-tsig-key commands by default", () => {
    const cmds = tsigManualCommands(KEY, ["example.com.", "example.net."]);
    expect(cmds.importOnSecondary).toBe("pdnsutil import-tsig-key p2s hmac-sha256 QUJDREVG");
    expect(cmds.secondaryPerZone).toEqual([
      "pdnsutil activate-tsig-key example.com. p2s secondary",
      "pdnsutil activate-tsig-key example.net. p2s secondary",
    ]);
    expect(cmds.primaryPerZone).toEqual([
      "pdnsutil activate-tsig-key example.com. p2s primary",
      "pdnsutil activate-tsig-key example.net. p2s primary",
    ]);
  });

  it("emits the 5.0 `pdnsutil tsigkey` subcommand form when modernCli is set", () => {
    const cmds = tsigManualCommands(KEY, ["example.com."], { modernCli: true });
    expect(cmds.importOnSecondary).toBe("pdnsutil tsigkey import p2s hmac-sha256 QUJDREVG");
    expect(cmds.secondaryPerZone).toEqual(["pdnsutil tsigkey activate example.com. p2s secondary"]);
    expect(cmds.primaryPerZone).toEqual(["pdnsutil tsigkey activate example.com. p2s primary"]);
  });

  it("omits per-zone commands when no zones are given", () => {
    const cmds = tsigManualCommands(KEY);
    expect(cmds.secondaryPerZone).toEqual([]);
    expect(cmds.primaryPerZone).toEqual([]);
  });
});
