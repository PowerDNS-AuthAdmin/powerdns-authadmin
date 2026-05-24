/**
 * tests/integration/zones/cryptokeys.test.ts
 *
 * POST/PUT/DELETE /api/admin/pdns/zones/[zoneId]/cryptokeys — DNSSEC
 * key management. DNSSEC is enabled on the test backends
 * (`g*-dnssec=yes` in docker/pdns/*.conf), so this covers real key
 * creation plus the permission + validation surface:
 *   - POST generates an active key that PDNS then lists,
 *   - permission-gated 403 for under-privileged users,
 *   - the validation surface (bad cryptokey id / missing flags → 400).
 *
 * Full end-to-end signing — DNSKEY/RRSIG served over DNS and the
 * presigned AXFR to a Secondary — lives in
 * tests/integration/dns/dnssec.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `dnssec-${Date.now()}-${tag}.example.com.`;
}

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind: "Master",
    nameservers: NS,
  });
}

interface PdnsCryptokey {
  id: number;
  keytype: string;
  active: boolean;
}

async function pdnsListCryptokeys(zone: string): Promise<PdnsCryptokey[]> {
  const backend = PDNS_BY_TOPOLOGY.standalone;
  const res = await fetch(`${backend.baseUrl}/servers/localhost/zones/${zone}/cryptokeys`, {
    headers: { "x-api-key": backend.apiKey },
  });
  if (!res.ok) throw new Error(`pdns list cryptokeys → ${res.status}`);
  return (await res.json()) as PdnsCryptokey[];
}

describe("DNSSEC cryptokeys route", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("a freshly-created zone has zero cryptokeys via direct PDNS", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const keys = await pdnsListCryptokeys(zone);
    expect(keys).toEqual([]);
  }, 15_000);

  it("POST generates an active cryptokey that PDNS then lists", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys`, {
      method: "POST",
      json: { serverSlug: "standalone", keytype: "ksk", algorithm: "ecdsa256" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      cryptokey: { id: number; keytype: string; active: boolean };
    };
    expect(body.ok).toBe(true);
    // PDNS reports a lone SEP key that signs the whole zone as a "csk"
    // (it does both KSK + ZSK duty), even though we asked for "ksk" — so
    // accept either. The point is a real, active key was generated.
    expect(["ksk", "csk"]).toContain(body.cryptokey.keytype);
    expect(body.cryptokey.active).toBe(true);

    const keys = await pdnsListCryptokeys(zone);
    expect(keys.some((k) => k.id === body.cryptokey.id)).toBe(true);
  }, 15_000);

  it("PUT with an invalid cryptokey id returns 400", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys/-1`,
      { method: "PUT", json: { serverSlug: "standalone", active: false } },
    );
    expect(res.status).toBe(400);
  });

  it("PUT without active/published flags returns 400", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys/1`, {
      method: "PUT",
      json: { serverSlug: "standalone" },
    });
    expect(res.status).toBe(400);
  });

  it("read-only role cannot POST a cryptokey (403)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const { client } = await createAndLogin(admin, {
      email: uniqueEmail("ro-dnssec"),
      name: "Read Only",
      password: "ro-dnssec-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const res = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys`, {
      method: "POST",
      json: { serverSlug: "standalone", keytype: "ksk", algorithm: "ecdsa256" },
    });
    expect(res.status).toBe(403);
  }, 15_000);

  it("operator role cannot POST a cryptokey (needs dnssec.configure → team-owner+)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const { client } = await createAndLogin(admin, {
      email: uniqueEmail("op-dnssec"),
      name: "Operator",
      password: "op-dnssec-pw-1234",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const res = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys`, {
      method: "POST",
      json: { serverSlug: "standalone", keytype: "ksk", algorithm: "ecdsa256" },
    });
    expect(res.status).toBe(403);
  }, 15_000);
});
