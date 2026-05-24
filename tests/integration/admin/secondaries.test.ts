/**
 * tests/integration/admin/secondaries.test.ts
 *
 * Read-only-by-zone-KIND + unpinned secondaries.
 *
 *   - An unpinned secondary backend (no app-managed primary) can be added.
 *   - A Slave/Secondary-kind zone's CONTENT (records, DNSSEC) is read-only —
 *     and that's decided by the ZONE KIND, not the backend's role: the test
 *     creates the mirror zone on the standalone *primary* backend and still
 *     gets 409 on content writes. Replication CONFIG (metadata) stays open.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";

// A primary-role backend — used on purpose to prove read-only follows the
// zone's kind, not the server's role.
const SERVER = "standalone";
const MIRROR_ZONE = "mirror-probe.example.com.";

describe("read-only by zone kind", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("allows adding an ungrouped backend (no group)", async () => {
    const admin = await loginAsBootstrap();
    const slug = `ungrouped-sec-${Date.now()}`;
    // A backend's primary/secondary nature is observed from /config after a
    // probe (ADR-0014), not declared — so the create response just confirms it
    // landed ungrouped (clusterId null).
    const { server } = await admin.sendJson<{
      server: { id: string; clusterId: string | null };
    }>("POST", "/api/admin/pdns-servers", {
      slug,
      name: "Ungrouped secondary",
      baseUrl: "http://pdns-ps-secondary-1:8081/api/v1",
      serverId: "localhost",
      apiKey: "throwaway-key",
    });
    expect(server.id).toBeTruthy();
    expect(server.clusterId).toBeNull();
    await admin.sendJson("DELETE", `/api/admin/pdns-servers/${server.id}`);
  }, 15_000);

  it("makes a Slave-kind zone read-only for content even on a primary backend", async () => {
    const admin = await loginAsBootstrap();
    // Create a mirror (Slave) zone on the PRIMARY-role standalone backend.
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: SERVER,
      name: MIRROR_ZONE,
      kind: "Slave",
      masters: ["192.0.2.1"],
    });

    // Records — blocked (read-only by kind).
    const rr = await admin.call(`/api/admin/pdns/zones/${encodeURIComponent(MIRROR_ZONE)}/rrsets`, {
      method: "PATCH",
      json: {
        serverSlug: SERVER,
        changes: [
          {
            kind: "upsert",
            name: `www.${MIRROR_ZONE}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.9" }],
          },
        ],
      },
    });
    expect(rr.status).toBe(409);
    const body = (await rr.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/AXFR|primary|read-only|mirror|slave/i);

    // DNSSEC — blocked (keys live on the primary).
    const ck = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(MIRROR_ZONE)}/cryptokeys`,
      { method: "POST", json: { serverSlug: SERVER, keytype: "csk", algorithm: "ecdsa256" } },
    );
    expect(ck.status).toBe(409);

    // Transfer metadata — NOT blocked (legitimate on a mirror).
    const md = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(MIRROR_ZONE)}/metadata/ALSO-NOTIFY`,
      { method: "PUT", json: { serverSlug: SERVER, values: ["192.0.2.53"] } },
    );
    expect(md.status).not.toBe(409);
  }, 30_000);
});
