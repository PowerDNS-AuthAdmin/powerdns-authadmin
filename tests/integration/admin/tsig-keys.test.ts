/**
 * tests/integration/admin/tsig-keys.test.ts
 *
 * /api/admin/pdns/tsig-keys - POST creates a TSIG key on the default
 * PDNS backend and returns a single-use revealToken instead of the raw
 * secret. The sibling /reveal endpoint redeems the token for the
 * plaintext as text/plain. DELETE removes the key from the backend. No
 * GET list/detail is exposed in this slice.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";
import { PDNS_BY_TOPOLOGY, type PdnsBackend, stripTrailingDot } from "../helpers/pdns";
import { pollDns } from "../helpers/dns"; // generic retry-until-truthy poller (no DNS)

interface TsigCreateResponse {
  ok: boolean;
  tsigKey: { id: string; name: string; algorithm: string };
  revealToken: string;
  expiresInSec: number;
}

function uniqueTsigName(prefix = "test-tsig"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("/api/admin/pdns/tsig-keys", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("POST creates a TSIG key and returns a revealToken (no plaintext in body)", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName();
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    expect(created.ok).toBe(true);
    expect(created.tsigKey.id).toBeTruthy();
    expect(created.revealToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((created.tsigKey as Record<string, unknown>)["key"]).toBeUndefined();
    expect(JSON.stringify(created)).not.toMatch(/"key"\s*:/);
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
  });

  it("POST /[id]/reveal returns the plaintext secret as text/plain exactly once", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName("reveal");
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    const first = await admin.call(
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/reveal`,
      { method: "POST", json: { token: created.revealToken } },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type") ?? "").toContain("text/plain");
    const secret = await first.text();
    expect(secret.length).toBeGreaterThan(0);

    const second = await admin.call(
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/reveal`,
      { method: "POST", json: { token: created.revealToken } },
    );
    expect(second.status).toBe(404);
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
  });

  it("DELETE removes the key - a follow-up DELETE returns 404", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName("del");
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
    const res = await admin.call(
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("audit log records tsig.create, tsig.reveal, tsig.delete", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName("audit");
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    await admin.call(`/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/reveal`, {
      method: "POST",
      json: { token: created.revealToken },
    });
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_type = 'tsig' AND resource_id = $1 ORDER BY ts",
      [created.tsigKey.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("tsig.create");
    expect(actions).toContain("tsig.reveal");
    expect(actions).toContain("tsig.delete");
  });
});

/** Raw PDNS TSIG list against a specific backend (bypasses the app). */
async function backendTsigKeys(b: PdnsBackend): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${b.baseUrl}/servers/localhost/tsigkeys`, {
    headers: { "X-API-Key": b.apiKey },
  });
  if (!res.ok) return [];
  return (await res.json()) as Array<{ id: string; name: string }>;
}

async function deleteBackendTsig(b: PdnsBackend, name: string): Promise<void> {
  for (const k of await backendTsigKeys(b)) {
    if (k.name !== name) continue;
    await fetch(`${b.baseUrl}/servers/localhost/tsigkeys/${encodeURIComponent(k.id)}`, {
      method: "DELETE",
      headers: { "X-API-Key": b.apiKey },
    });
  }
}

interface InstallResponse {
  ok: boolean;
  results: Array<{ serverSlug: string; outcome: string }>;
}

interface ZoneTransferResponse {
  ok: boolean;
  primaryOk: boolean;
  secondaries: Array<{ serverSlug: string; hosted: boolean; ok: boolean }>;
}

/** Raw PDNS getZone - reads the writable TSIG key-id fields the app sets,
 *  trailing dots stripped so they compare equal to the dot-less key name. */
async function backendZone(
  b: PdnsBackend,
  zoneId: string,
): Promise<{ master_tsig_key_ids: string[]; slave_tsig_key_ids: string[] } | null> {
  const res = await fetch(`${b.baseUrl}/servers/localhost/zones/${encodeURIComponent(zoneId)}`, {
    headers: { "X-API-Key": b.apiKey },
  });
  if (!res.ok) return null;
  const z = (await res.json()) as {
    master_tsig_key_ids?: string[];
    slave_tsig_key_ids?: string[];
  };
  return {
    master_tsig_key_ids: (z.master_tsig_key_ids ?? []).map(stripTrailingDot),
    slave_tsig_key_ids: (z.slave_tsig_key_ids ?? []).map(stripTrailingDot),
  };
}

/** Raw PDNS getTsigKey - returns the base64 secret (for replication-fidelity checks). */
async function backendTsigSecret(b: PdnsBackend, id: string): Promise<string | null> {
  const res = await fetch(`${b.baseUrl}/servers/localhost/tsigkeys/${encodeURIComponent(id)}`, {
    headers: { "X-API-Key": b.apiKey },
  });
  if (!res.ok) return null;
  return ((await res.json()) as { key?: string }).key ?? null;
}

/** Raw PDNS: does this backend currently serve `name` A == `content`? Proves a
 *  primary edit reached a secondary over AXFR (the secondary is read-only). */
async function backendHasA(
  b: PdnsBackend,
  zoneId: string,
  name: string,
  content: string,
): Promise<boolean> {
  const res = await fetch(`${b.baseUrl}/servers/localhost/zones/${encodeURIComponent(zoneId)}`, {
    headers: { "X-API-Key": b.apiKey },
  });
  if (!res.ok) return false;
  const z = (await res.json()) as {
    rrsets?: Array<{ name: string; type: string; records?: Array<{ content: string }> }>;
  };
  return (z.rrsets ?? []).some(
    (r) =>
      r.name === name && r.type === "A" && (r.records ?? []).some((x) => x.content === content),
  );
}

async function deleteBackendZone(b: PdnsBackend, zoneId: string): Promise<void> {
  await fetch(`${b.baseUrl}/servers/localhost/zones/${encodeURIComponent(zoneId)}`, {
    method: "DELETE",
    headers: { "X-API-Key": b.apiKey },
  });
}

describe("/api/admin/pdns/tsig-keys/[id]/install", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("replicates the key onto the primary's secondaries", async () => {
    const admin = await loginAsBootstrap();
    // Probe versions + capabilities so the secondaries are enumerable (they must
    // be observed as read-only mirrors) and report `supportsTsigApi`.
    await admin.call("/api/admin/pdns-servers/refresh-all", { method: "POST" });

    const name = uniqueTsigName("install");
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      serverSlug: PDNS_BY_TOPOLOGY.psPrimary.slug,
      name,
      algorithm: "hmac-sha256",
    });

    try {
      const res = await admin.sendJson<InstallResponse>(
        "POST",
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/install`,
        { serverSlug: PDNS_BY_TOPOLOGY.psPrimary.slug },
      );
      expect(res.ok).toBe(true);
      expect(res.results.length).toBeGreaterThan(0);
      // Every secondary either got it or already had the identical key.
      for (const r of res.results) {
        expect(["created", "unchanged"]).toContain(r.outcome);
      }

      // It actually landed on a secondary (verified directly against PDNS).
      const onSecondary = await backendTsigKeys(PDNS_BY_TOPOLOGY.psSecondaries[0]!);
      const secKey = onSecondary.find((k) => k.name === name);
      expect(secKey).toBeTruthy();

      // …and the SECRET matches the primary's exactly - a same-named key with a
      // different secret would silently break AXFR, so verify replication fidelity.
      const [primarySecret, secondarySecret] = await Promise.all([
        backendTsigSecret(PDNS_BY_TOPOLOGY.psPrimary, created.tsigKey.id),
        backendTsigSecret(PDNS_BY_TOPOLOGY.psSecondaries[0]!, secKey!.id),
      ]);
      expect(secondarySecret).toBeTruthy();
      expect(secondarySecret).toBe(primarySecret);

      // Re-running is idempotent - same secret already present.
      const again = await admin.sendJson<InstallResponse>(
        "POST",
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/install`,
        { serverSlug: PDNS_BY_TOPOLOGY.psPrimary.slug },
      );
      for (const r of again.results) expect(r.outcome).toBe("unchanged");
    } finally {
      // Cleanup on every backend that may now hold the key.
      await deleteBackendTsig(PDNS_BY_TOPOLOGY.psPrimary, name);
      for (const s of PDNS_BY_TOPOLOGY.psSecondaries) await deleteBackendTsig(s, name);
    }
  }, 30_000);
});

describe("/api/admin/pdns/zones/[zoneId]/tsig-transfer", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("adds/removes a zone's transfer key via the zone fields, without clobbering others", async () => {
    const admin = await loginAsBootstrap();
    const primary = PDNS_BY_TOPOLOGY.psPrimary;
    const zone = `tsig-xfer-${Date.now().toString(36)}.example.`;
    const k1 = uniqueTsigName("xfer-a");
    const k2 = uniqueTsigName("xfer-b");

    // Two keys on the primary, and a Master zone to secure.
    await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      serverSlug: primary.slug,
      name: k1,
      algorithm: "hmac-sha256",
    });
    await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      serverSlug: primary.slug,
      name: k2,
      algorithm: "hmac-sha256",
    });
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: primary.slug,
      name: zone,
      kind: "Master",
      nameservers: ["ns1.example."],
    });

    try {
      const transfer = (keyName: string, mode: "add" | "remove") =>
        admin.sendJson<ZoneTransferResponse>(
          "POST",
          `/api/admin/pdns/zones/${encodeURIComponent(zone)}/tsig-transfer`,
          { serverSlug: primary.slug, keyName, mode },
        );

      // Add k1 - this is the path that 422'd against the read-only metadata API;
      // via master_tsig_key_ids it must now succeed.
      const add1 = await transfer(k1, "add");
      expect(add1.ok).toBe(true);
      expect(add1.primaryOk).toBe(true);
      let z = await backendZone(primary, zone);
      expect(z?.master_tsig_key_ids ?? []).toContain(k1);

      // Add k2 - k1 must be preserved (non-clobber).
      await transfer(k2, "add");
      z = await backendZone(primary, zone);
      expect(z?.master_tsig_key_ids ?? []).toEqual(expect.arrayContaining([k1, k2]));

      // Remove k1 - k2 stays.
      await transfer(k1, "remove");
      z = await backendZone(primary, zone);
      const ids = z?.master_tsig_key_ids ?? [];
      expect(ids).toContain(k2);
      expect(ids).not.toContain(k1);
    } finally {
      // Raw PDNS cleanup against the primary (deterministic, no serverSlug query).
      await deleteBackendZone(primary, zone);
      await deleteBackendTsig(primary, k1);
      await deleteBackendTsig(primary, k2);
    }
  }, 30_000);
});

describe("DELETE /api/admin/pdns/tsig-keys/[id]?cascade=true", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("strips the key from zones + secondaries, then deletes it from the primary", async () => {
    const admin = await loginAsBootstrap();
    const primary = PDNS_BY_TOPOLOGY.psPrimary;
    const secondary = PDNS_BY_TOPOLOGY.psSecondaries[0]!;
    await admin.call("/api/admin/pdns-servers/refresh-all", { method: "POST" });

    const name = uniqueTsigName("cascade");
    const zone = `cascade-${Date.now().toString(36)}.example.`;
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      serverSlug: primary.slug,
      name,
      algorithm: "hmac-sha256",
    });

    try {
      // Replicate to secondaries, create a zone, and secure it with the key.
      await admin.sendJson<InstallResponse>(
        "POST",
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/install`,
        { serverSlug: primary.slug },
      );
      await admin.sendJson("POST", "/api/admin/pdns/zones", {
        serverSlug: primary.slug,
        name: zone,
        kind: "Master",
        nameservers: ["ns1.example."],
      });
      await admin.sendJson<ZoneTransferResponse>(
        "POST",
        `/api/admin/pdns/zones/${encodeURIComponent(zone)}/tsig-transfer`,
        { serverSlug: primary.slug, keyName: name, mode: "add" },
      );

      // Sanity: the key is on the primary, the secondary, and the zone.
      expect((await backendTsigKeys(primary)).some((k) => k.name === name)).toBe(true);
      expect((await backendTsigKeys(secondary)).some((k) => k.name === name)).toBe(true);
      expect((await backendZone(primary, zone))?.master_tsig_key_ids ?? []).toContain(name);

      // Warm the broker cache so the cascade's zone scan sees the new zone, then
      // delete WITH cascade.
      await admin.call("/api/admin/pdns-servers/refresh-all", { method: "POST" });
      const delUrl =
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}` +
        `?serverSlug=${encodeURIComponent(primary.slug)}&cascade=true`;
      const res = await admin.sendJson<{ ok: boolean; cascade: { zonesUpdated: number } | null }>(
        "DELETE",
        delUrl,
      );
      expect(res.ok).toBe(true);

      // Gone everywhere: primary, secondary, and the zone's transfer config.
      expect((await backendTsigKeys(primary)).some((k) => k.name === name)).toBe(false);
      expect((await backendTsigKeys(secondary)).some((k) => k.name === name)).toBe(false);
      expect((await backendZone(primary, zone))?.master_tsig_key_ids ?? []).not.toContain(name);
    } finally {
      await deleteBackendZone(primary, zone);
      await deleteBackendTsig(primary, name);
      for (const s of PDNS_BY_TOPOLOGY.psSecondaries) await deleteBackendTsig(s, name);
    }
  }, 30_000);

  it("cascade=false (opt-out) deletes the key from the primary ONLY", async () => {
    const admin = await loginAsBootstrap();
    const primary = PDNS_BY_TOPOLOGY.psPrimary;
    const secondary = PDNS_BY_TOPOLOGY.psSecondaries[0]!;
    await admin.call("/api/admin/pdns-servers/refresh-all", { method: "POST" });

    const name = uniqueTsigName("keyonly");
    const zone = `keyonly-${Date.now().toString(36)}.example.`;
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      serverSlug: primary.slug,
      name,
      algorithm: "hmac-sha256",
    });

    try {
      await admin.sendJson<InstallResponse>(
        "POST",
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/install`,
        { serverSlug: primary.slug },
      );
      await admin.sendJson("POST", "/api/admin/pdns/zones", {
        serverSlug: primary.slug,
        name: zone,
        kind: "Master",
        nameservers: ["ns1.example."],
      });
      await admin.sendJson<ZoneTransferResponse>(
        "POST",
        `/api/admin/pdns/zones/${encodeURIComponent(zone)}/tsig-transfer`,
        { serverSlug: primary.slug, keyName: name, mode: "add" },
      );

      // Opt OUT of the cleanup - the unchecked-checkbox path: key-only delete.
      await admin.sendJson(
        "DELETE",
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}` +
          `?serverSlug=${encodeURIComponent(primary.slug)}&cascade=false`,
      );

      // Gone from the primary, but the secondary copy AND the zone reference are
      // left in place - exactly what opting out means.
      expect((await backendTsigKeys(primary)).some((k) => k.name === name)).toBe(false);
      expect((await backendTsigKeys(secondary)).some((k) => k.name === name)).toBe(true);
      expect((await backendZone(primary, zone))?.master_tsig_key_ids ?? []).toContain(name);
    } finally {
      await deleteBackendZone(primary, zone);
      await deleteBackendTsig(primary, name);
      for (const s of PDNS_BY_TOPOLOGY.psSecondaries) await deleteBackendTsig(s, name);
    }
  }, 30_000);
});

describe("TSIG mutations keep AXFR replication working (ps topology)", () => {
  beforeEach(() => resetState());

  it("a primary record edit still reaches the secondary after add AND after remove", async () => {
    const admin = await loginAsBootstrap();
    const primary = PDNS_BY_TOPOLOGY.psPrimary;
    const secondary = PDNS_BY_TOPOLOGY.psSecondaries[0]!;
    await admin.call("/api/admin/pdns-servers/refresh-all", { method: "POST" });

    const zone = `tsig-repl-${Date.now().toString(36)}.example.`;
    const name = uniqueTsigName("repl");
    // NS = the secondaries' supermaster hostnames so autosecondary accepts the
    // NOTIFY and AXFRs the zone (same wiring the DNSSEC ps test relies on).
    const ns = PDNS_BY_TOPOLOGY.psSecondaries.map((s) => `pdns-${s.slug}.`);
    const a1 = `a1.${zone}`;
    const a2 = `a2.${zone}`;

    const upsertA = (rrName: string, ip: string): Promise<unknown> =>
      admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
        serverSlug: primary.slug,
        changes: [{ kind: "upsert", name: rrName, type: "A", ttl: 60, records: [{ content: ip }] }],
      });
    const replicated = (rrName: string, ip: string, label: string): Promise<unknown> =>
      pollDns(async () => ((await backendHasA(secondary, zone, rrName, ip)) ? true : null), {
        label,
        timeoutMs: 60_000,
        intervalMs: 2000,
      });

    try {
      await admin.sendJson("POST", "/api/admin/pdns/zones", {
        serverSlug: primary.slug,
        name: zone,
        kind: "Master",
        nameservers: ns,
      });

      // Zone reaches the secondary via the initial AXFR.
      await pollDns(async () => ((await backendZone(secondary, zone)) ? true : null), {
        label: "zone replicated to secondary",
        timeoutMs: 60_000,
        intervalMs: 2000,
      });

      // App flow (same calls the UI makes): create → install → secure the zone.
      const created = await admin.sendJson<TsigCreateResponse>(
        "POST",
        "/api/admin/pdns/tsig-keys",
        { serverSlug: primary.slug, name, algorithm: "hmac-sha256" },
      );
      await admin.sendJson<InstallResponse>(
        "POST",
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/install`,
        { serverSlug: primary.slug },
      );
      await admin.sendJson<ZoneTransferResponse>(
        "POST",
        `/api/admin/pdns/zones/${encodeURIComponent(zone)}/tsig-transfer`,
        { serverSlug: primary.slug, keyName: name, mode: "add" },
      );

      // The app configured TSIG transfer on BOTH sides (read fresh off PDNS).
      expect((await backendZone(primary, zone))?.master_tsig_key_ids ?? []).toContain(name);
      expect((await backendZone(secondary, zone))?.slave_tsig_key_ids ?? []).toContain(name);

      // ADD: edit a record on the primary; it must reach the secondary over AXFR.
      await upsertA(a1, "192.0.2.81");
      await replicated(a1, "192.0.2.81", "AXFR replicated the edit after ADD");

      // REMOVE the transfer key; the zone config clears on both sides.
      await admin.sendJson<ZoneTransferResponse>(
        "POST",
        `/api/admin/pdns/zones/${encodeURIComponent(zone)}/tsig-transfer`,
        { serverSlug: primary.slug, keyName: name, mode: "remove" },
      );
      expect((await backendZone(primary, zone))?.master_tsig_key_ids ?? []).not.toContain(name);
      expect((await backendZone(secondary, zone))?.slave_tsig_key_ids ?? []).not.toContain(name);

      // REMOVE: another primary edit must STILL reach the secondary (replication
      // is not broken by clearing the transfer key).
      await upsertA(a2, "192.0.2.82");
      await replicated(a2, "192.0.2.82", "AXFR replicated the edit after REMOVE");
    } finally {
      await deleteBackendZone(primary, zone);
      await deleteBackendZone(secondary, zone);
      await deleteBackendTsig(primary, name);
      for (const s of PDNS_BY_TOPOLOGY.psSecondaries) await deleteBackendTsig(s, name);
    }
  }, 180_000);
});
