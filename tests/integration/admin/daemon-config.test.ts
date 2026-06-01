/**
 * tests/integration/admin/daemon-config.test.ts
 *
 * Cross-backend contract test for the read-only `/config` endpoint that the
 * observed capability snapshot (ADR-0014, lib/pdns/capabilities) is derived
 * from. Runs against EVERY pdns-auth version in the CI matrix, so a future
 * PowerDNS release that renames or drops a replication flag fails here loudly.
 *
 * deriveCapabilities() itself is unit-tested (lib/pdns/capabilities.test.ts);
 * this proves the live data source is shaped the way that unit test assumes -
 * across a primary daemon, a secondary daemon, and every backend in the stack.
 */

import { describe, expect, it } from "vitest";
import {
  getConfig,
  PDNS_BACKENDS,
  PDNS_BY_TOPOLOGY,
  type PdnsConfigSetting,
} from "../helpers/pdns";

function flag(config: PdnsConfigSetting[], name: string): string | undefined {
  return config.find((c) => c.name.toLowerCase() === name)?.value.toLowerCase();
}
const isYes = (config: PdnsConfigSetting[], name: string): boolean => flag(config, name) === "yes";
/** modern flag OR its pre-4.5 legacy alias - either being yes counts. */
const cap = (config: PdnsConfigSetting[], modern: string, legacy: string): boolean =>
  isYes(config, modern) || isYes(config, legacy);

describe("daemon /config capability contract", () => {
  it("a primary daemon reports primary capability + DNSSEC, not secondary", async () => {
    for (const b of [PDNS_BY_TOPOLOGY.standalone, PDNS_BY_TOPOLOGY.psPrimary]) {
      const config = await getConfig(b);
      expect(cap(config, "primary", "master"), `${b.slug} primary`).toBe(true);
      expect(cap(config, "secondary", "slave"), `${b.slug} not secondary`).toBe(false);
      // launch + <backend>-dnssec are what drive the snapshot's dnssec flag.
      expect(flag(config, "launch")).toContain("gsqlite3");
      expect(isYes(config, "gsqlite3-dnssec"), `${b.slug} dnssec`).toBe(true);
    }
  });

  it("a secondary daemon reports secondary + autosecondary capability", async () => {
    const b = PDNS_BY_TOPOLOGY.psSecondaries[0]!;
    const config = await getConfig(b);
    expect(cap(config, "secondary", "slave"), `${b.slug} secondary`).toBe(true);
    expect(cap(config, "autosecondary", "superslave"), `${b.slug} autosecondary`).toBe(true);
  });

  it("every backend exposes /config with an api flag + launch (snapshot precondition)", async () => {
    for (const b of PDNS_BACKENDS) {
      const config = await getConfig(b);
      expect(isYes(config, "api"), `${b.slug} api`).toBe(true);
      expect((flag(config, "launch") ?? "").length, `${b.slug} launch`).toBeGreaterThan(0);
    }
  });
});
