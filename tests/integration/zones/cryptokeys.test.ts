/**
 * tests/integration/zones/cryptokeys.test.ts
 *
 * POST/PUT/DELETE /api/admin/pdns/zones/[zoneId]/cryptokeys — DNSSEC
 * key management. The test PDNS images don't have DNSSEC enabled at
 * the backend layer (`g*-dnssec=yes` is off in docker/pdns/*.conf),
 * so the happy-path "create a real key" assertion can't run here.
 * Instead we exercise:
 *   - permission-gated 403 for under-privileged users,
 *   - the validation surface (bad cryptokey id → 400),
 *   - the 502 contract the route surfaces when PDNS refuses,
 *   - the direct-PDNS cryptokey listing (always empty here, but the
 *     plumbing is covered for completeness).
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

  it("POST surfaces PDNS' DNSSEC-disabled error as 502 (test stack has DNSSEC off)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys`, {
      method: "POST",
      json: { serverSlug: "standalone", keytype: "ksk", algorithm: "ecdsa256" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/PDNS|DNSSEC/i);
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
