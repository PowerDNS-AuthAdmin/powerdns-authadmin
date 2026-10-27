/**
 * tests/integration/zones/monitoring.test.ts
 *
 * Zone monitoring surfaces: the state endpoint, its permission gate, the
 * manual refresh with its rate limit, and the batch re-check a bulk fix runs. The checks themselves walk the public
 * DNS tree and are covered by unit tests with a scripted internet
 * (lib/dns/delegation.test.ts, lib/dns/zone-checks.test.ts); here we only
 * assert the HTTP contract against the test stack's own zones.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";

interface MonitorState {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  results: Array<{
    zone: string;
    server: string;
    horizon: string;
    severity: string | null;
    findings: unknown[];
    canUpdateSoa?: boolean;
  }>;
  counts: { zones: number; error: number; warn: number; info: number; ok: number };
}

describe("zone monitoring API", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("returns the monitor state to zone readers and refuses users without zone.read", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/monitoring/zones", { method: "GET" });
    expect(res.status).toBe(200);
    const state = (await res.json()) as MonitorState;
    expect(typeof state.enabled).toBe("boolean");
    expect(state.intervalMs).toBeGreaterThanOrEqual(60_000);
    expect(Array.isArray(state.results)).toBe(true);
    expect(state.counts.zones).toBe(state.results.length);
    // The bulk fix's review lists zones the viewer can't change; an admin can change them all.
    for (const r of state.results) expect(r.canUpdateSoa).toBe(true);

    const { client: nobody } = await createAndLogin(admin, {
      email: uniqueEmail("mon-nobody"),
      name: "Monitor nobody",
      password: "mon-nobody-test-pw-1234",
    });
    expect((await nobody.call("/api/admin/monitoring/zones", { method: "GET" })).status).toBe(403);
    expect(
      (await nobody.call("/api/admin/monitoring/zones/refresh", { method: "POST", json: {} }))
        .status,
    ).toBe(403);
  }, 30_000);

  it("re-checks one zone on demand, reports its findings, and rate-limits repeats", async () => {
    const admin = await loginAsBootstrap();
    const zone = `mon-${Date.now()}.example.com.`;
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: ["ns1.example.com.", "ns2.example.com."],
    });
    // The fleet scan is cached for a minute; ask for a fresh one so the new zone is known.
    await admin.call("/api/admin/pdns/auto-ptr/report?refresh=1", { method: "GET" });

    const first = await admin.call("/api/admin/monitoring/zones/refresh", {
      method: "POST",
      json: { zone, serverSlug: "standalone" },
    });
    expect([200, 429]).toContain(first.status);
    if (first.status === 200) {
      const { result } = (await first.json()) as { result: MonitorState["results"][number] | null };
      // The zone may be unknown to the monitor until its next full cycle; when it
      // is known, the shape is complete.
      if (result) {
        expect(result.zone).toBe(zone);
        expect(result.server).toBe("standalone");
        expect(["public", "internal"]).toContain(result.horizon);
        expect(Array.isArray(result.findings)).toBe(true);
      }
      const again = await admin.call("/api/admin/monitoring/zones/refresh", {
        method: "POST",
        json: { zone, serverSlug: "standalone" },
      });
      expect(again.status).toBe(429);
    }
    const bad = await admin.call("/api/admin/monitoring/zones/refresh", {
      method: "POST",
      json: { zone: "not a zone!", serverSlug: "standalone" },
    });
    expect(bad.status).toBe(400);
  }, 90_000);

  it("re-checks a batch of zones in one pass and skips those checked moments ago", async () => {
    const admin = await loginAsBootstrap();
    const zone = `mon-batch-${Date.now()}.example.com.`;
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: ["ns1.example.com.", "ns2.example.com."],
    });
    await admin.call("/api/admin/pdns/auto-ptr/report?refresh=1", { method: "GET" });

    const batch = {
      zones: [
        { zone, serverSlug: "standalone" },
        // An unknown backend is dropped, not an error: the batch comes from results on screen.
        { zone, serverSlug: "no-such-backend" },
      ],
    };
    const first = await admin.call("/api/admin/monitoring/zones/refresh", {
      method: "POST",
      json: batch,
    });
    expect(first.status).toBe(200);
    const state = (await first.json()) as MonitorState & { checked: number };
    expect(state.checked).toBe(1);
    expect(state.counts.zones).toBe(state.results.length);
    for (const r of state.results) expect(r.canUpdateSoa).toBe(true);

    const again = await admin.call("/api/admin/monitoring/zones/refresh", {
      method: "POST",
      json: batch,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { checked: number }).checked).toBe(0);

    const empty = await admin.call("/api/admin/monitoring/zones/refresh", {
      method: "POST",
      json: { zones: [] },
    });
    expect(empty.status).toBe(400);
  }, 90_000);
});
