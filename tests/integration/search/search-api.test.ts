/**
 * tests/integration/search/search-api.test.ts
 *
 * The global search endpoint behind the header palette and the MCP `search`
 * tool: an admin finds a zone it just created, a user without roles gets
 * nothing, and malformed queries are rejected.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

interface SearchBody {
  q: string;
  scope: string;
  groups: Array<{
    key: string;
    total: number;
    items: Array<{ kind: string; title: string; href: string; meta?: Record<string, string> }>;
  }>;
  counts: {
    zones: number;
    records: number;
    config: number;
    requests: number | null;
    audit: number | null;
  };
}

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

describe("global search API", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("finds a zone the admin just created, scoped and permission-filtered", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("gsearch");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });
    // Searches answer from a prebuilt index that is rebuilt and hot-swapped a
    // moment after a change (lib/search/search-index.ts), so poll for the swap.
    const label = zone.replace(/\.example\.com\.$/, "");
    let res: Response | null = null;
    let body: SearchBody | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      res = await admin.call(`/api/search?q=${encodeURIComponent(label)}&scope=zones`, {
        method: "GET",
      });
      expect(res.status).toBe(200);
      body = (await res.json()) as SearchBody;
      if (body.groups.some((g) => g.items.some((i) => i.title === zone.slice(0, -1)))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(res!.headers.get("cache-control")).toContain("no-store");
    body = body!;
    expect(body.scope).toBe("zones");
    expect(body.groups.map((g) => g.key)).toEqual(["zones"]);
    const hit = body.groups[0]!.items.find((i) => i.title === zone.slice(0, -1));
    expect(hit).toMatchObject({ kind: "zone", meta: { backend: "standalone" } });
    expect(hit!.href).toBe(`/zones/${encodeURIComponent(zone)}?server=standalone`);
    expect(body.counts.zones).toBeGreaterThanOrEqual(1);

    // A user with no roles sees the same query come back empty.
    const { client: nobody } = await createAndLogin(admin, {
      email: uniqueEmail("gsearch-nobody"),
      name: "Search nobody",
      password: "gsearch-nobody-test-pw-1234",
    });
    const empty = await nobody.call(`/api/search?q=${encodeURIComponent(label)}`, {
      method: "GET",
    });
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as SearchBody;
    expect(emptyBody.groups).toEqual([]);
    // The logs are not searched under All, so their counts are null rather than 0.
    expect(emptyBody.counts).toEqual({
      zones: 0,
      records: 0,
      config: 0,
      requests: null,
      audit: null,
    });
  }, 60_000);

  it("rejects an over-long query and an unknown scope", async () => {
    const admin = await loginAsBootstrap();
    const long = await admin.call(`/api/search?q=${"a".repeat(101)}`, { method: "GET" });
    expect(long.status).toBe(400);
    const blank = await admin.call("/api/search?q=%20%20", { method: "GET" });
    expect(blank.status).toBe(400);
    const scope = await admin.call("/api/search?q=example&scope=docs", { method: "GET" });
    expect(scope.status).toBe(400);
    const ok = await admin.call("/api/search?q=example&scope=config", { method: "GET" });
    expect(ok.status).toBe(200);
  });
});
