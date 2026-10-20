import { describe, expect, it } from "vitest";
import {
  searchEverything,
  searchTabVisibility,
  type SearchAuth,
  type SearchSources,
} from "./index";

/** A source that resolves to fixed rows. */
const rows =
  <T>(items: T[]) =>
  (): Promise<T[]> =>
    Promise.resolve(items);

const SECRETS = {
  apiKey: "seeded-pdns-api-key-7f3a",
  password: "seeded-password-hash-argon2",
  tsig: "c2VlZGVkLXRzaWctc2VjcmV0",
  clientSecret: "seeded-oidc-client-secret",
  session: "seeded-session-id-9c1d",
  body: "seeded-request-body-content",
};

/**
 * Fake sources. The row shapes cannot carry secrets, so the seeded strings go
 * where a careless implementation would have copied them from: a session id
 * in an audit resource id, a URL query string on a request.
 */
function fakeSources(): SearchSources {
  return {
    zones: rows([
      {
        name: "example.com.",
        serverId: "srv-a",
        serverSlug: "alpha",
        serverName: "Alpha",
        clusterSlug: null,
        horizon: "public",
        kind: "Native",
      },
      {
        name: "secret-lab.net.",
        serverId: "srv-b",
        serverSlug: "beta",
        serverName: "Beta",
        clusterSlug: "edge",
        horizon: "internal",
        kind: "Master",
      },
    ]),
    records: rows([
      {
        zone: "example.com.",
        serverId: "srv-a",
        serverSlug: "alpha",
        clusterSlug: null,
        name: "www.example.com.",
        type: "A",
        contents: ["192.0.2.10"],
      },
      {
        zone: "secret-lab.net.",
        serverId: "srv-b",
        serverSlug: "beta",
        clusterSlug: "edge",
        name: "db.secret-lab.net.",
        type: "A",
        contents: ["198.51.100.20"],
      },
    ]),
    settings: rows([{ key: "site_name", label: "Site name", value: "Example DNS" }]),
    backends: rows([{ id: "srv-a", slug: "alpha", name: "Alpha", host: "pdns.example:8081" }]),
    clusters: rows([{ id: "cl-1", slug: "edge", name: "Edge cluster" }]),
    users: rows([{ id: "u-1", name: "Example Operator", email: "operator@example.com" }]),
    teams: rows([
      { id: "t-1", slug: "example-team", name: "Example team" },
      { id: "t-2", slug: "other-team", name: "Other example team" },
    ]),
    roles: rows([{ id: "r-1", slug: "example-editor", name: "Example editor" }]),
    templates: rows([{ id: "tpl-1", slug: "example-default", name: "Example default" }]),
    authProviders: rows([
      { id: "p-1", protocol: "oidc", slug: "example-sso", name: "Example SSO" },
    ]),
    requests: rows([
      {
        id: "1",
        ts: new Date("2026-01-01T00:00:00Z"),
        op: "zones.get",
        method: "GET",
        path: "/api/v1/servers/localhost/zones/example.com.",
        status: 200,
        serverSlug: "alpha",
        requestId: "req-1",
      },
    ]),
    audit: rows([
      {
        id: "10",
        ts: new Date("2026-01-01T00:00:00Z"),
        actorType: "user",
        actorName: "Example Operator",
        actorEmail: "operator@example.com",
        action: "session.revoke",
        resourceType: "session",
        resourceId: SECRETS.session,
        requestId: null,
      },
      {
        id: "11",
        ts: new Date("2026-01-01T00:00:00Z"),
        actorType: "user",
        actorName: "Example Operator",
        actorEmail: "operator@example.com",
        action: "zone.create",
        resourceType: "zone",
        resourceId: "alpha:example.com.",
        requestId: null,
      },
    ]),
  };
}

const ALL_PERMISSIONS = [
  "zone.read",
  "record.read",
  "settings.read",
  "server.read",
  "server.update",
  "user.read",
  "team.read",
  "role.read",
  "template.use",
  "auth.read",
  "audit.read",
  "tsig.read",
  "system.backup",
];

function auth(permissions: string[], extra: Partial<SearchAuth> = {}): SearchAuth {
  return {
    globalPermissions: new Set(permissions),
    zoneGrants: [],
    canReadTeam: () => false,
    ...extra,
  };
}

const run = (
  q: string,
  a: SearchAuth,
  scope: Parameters<typeof searchEverything>[0]["scope"] = "all",
) => searchEverything({ q, scope, auth: a, sources: fakeSources() });

describe("searchEverything", () => {
  it("finds zones, records and config for a fully privileged user", async () => {
    const res = await run("example", auth(ALL_PERMISSIONS));
    expect(res.groups.map((g) => g.key)).toEqual([
      "zones",
      "records",
      "config",
      "requests",
      "audit",
    ]);
    const zone = res.groups.find((g) => g.key === "zones")!.items[0]!;
    expect(zone).toMatchObject({
      kind: "zone",
      title: "example.com",
      href: "/zones/example.com.?server=alpha",
      meta: { backend: "alpha", horizon: "public", kind: "Native" },
    });
    expect(zone.ranges.length).toBeGreaterThan(0);
  });

  it("returns empty groups and zero counts for a user without permissions", async () => {
    const res = await run("example", auth([]));
    expect(res.counts).toEqual({ zones: 0, records: 0, config: 0, requests: 0, audit: 0 });
    expect(res.groups).toEqual([]);
  });

  it("filters zones and records through zone grants on the right backend", async () => {
    const res = await run(
      "lab",
      auth([], {
        zoneGrants: [
          { serverId: "srv-b", zoneName: "secret-lab.net.", permissions: ["zone.read"] },
          { serverId: "srv-a", zoneName: "secret-lab.net.", permissions: ["record.read"] },
        ],
      }),
    );
    expect(res.counts.zones).toBe(1);
    // The record grant is on the wrong backend, so no record is visible.
    expect(res.counts.records).toBe(0);
    const zone = res.groups[0]!.items[0]!;
    // Cluster zones are addressed by their cluster.
    expect(zone.href).toBe("/zones/secret-lab.net.?cluster=edge");
  });

  it("matches record content and links with the content as the table filter", async () => {
    const res = await run("192.0.2", auth(["record.read"]), "records");
    const rec = res.groups[0]!.items[0]!;
    expect(rec).toMatchObject({ kind: "record", title: "www.example.com", subtitle: "192.0.2.10" });
    expect(rec.meta).toEqual({ type: "A", content: "192.0.2.10", zone: "example.com" });
    expect(rec.subtitleRanges?.length).toBeGreaterThan(0);
    expect(rec.href).toBe("/zones/example.com.?server=alpha&q=192.0.2.10");
  });

  it("gates each config source on its own permission", async () => {
    const onlyUsers = await run("example", auth(["user.read"]), "config");
    const sections = new Set(onlyUsers.groups[0]!.items.map((i) => i.meta?.["section"]));
    expect(sections).toEqual(new Set(["User"]));

    const onlySettings = await run("site", auth(["settings.read"]), "config");
    expect(onlySettings.groups[0]!.items.map((i) => i.kind)).toContain("setting");
    expect(onlySettings.groups[0]!.items.map((i) => i.kind)).not.toContain("user");

    const backup = await run("backup", auth(["settings.read"]), "config");
    expect(backup.counts.config).toBe(0);
    const backupAdmin = await run("backup", auth(["system.backup"]), "config");
    expect(backupAdmin.groups[0]!.items[0]!.href).toBe("/admin/settings/backup");
  });

  it("shows team-scoped owners only their own teams", async () => {
    const res = await run("team", auth([], { canReadTeam: (id) => id === "t-1" }), "config");
    const titles = res.groups[0]!.items.map((i) => i.title);
    expect(titles).toContain("Example team");
    expect(titles).not.toContain("Other example team");
    // The Teams page itself opens for them too.
    expect(titles).toContain("Teams");
  });

  it("keeps requests and audit behind audit.read", async () => {
    const without = await run("zone", auth(ALL_PERMISSIONS.filter((p) => p !== "audit.read")));
    expect(without.counts.requests).toBe(0);
    expect(without.counts.audit).toBe(0);
    const withAudit = await run("zones.get", auth(["audit.read"]), "requests");
    expect(withAudit.groups[0]!.items[0]).toMatchObject({
      kind: "request",
      href: "/admin/requests?requestId=req-1",
      meta: { method: "GET", status: "200", backend: "alpha" },
    });
  });

  it("narrows returned groups to the scope but still counts every tab", async () => {
    const res = await run("example", auth(ALL_PERMISSIONS), "zones");
    expect(res.groups.map((g) => g.key)).toEqual(["zones"]);
    expect(res.counts.records).toBeGreaterThan(0);
    expect(res.counts.config).toBeGreaterThan(0);
  });

  it("caps items per group: 6 in all, 25 for one tab, total stays exact", async () => {
    const many: SearchSources = {
      ...fakeSources(),
      users: rows(
        Array.from({ length: 40 }, (_, i) => ({
          id: `u-${i}`,
          name: `Example user ${i}`,
          email: `user${i}@example.com`,
        })),
      ),
    };
    const all = await searchEverything({
      q: "example user",
      scope: "all",
      auth: auth(["user.read"]),
      sources: many,
    });
    expect(all.groups[0]!.items).toHaveLength(6);
    expect(all.groups[0]!.total).toBe(40);
    const one = await searchEverything({
      q: "example user",
      scope: "config",
      auth: auth(["user.read"]),
      sources: many,
    });
    expect(one.groups[0]!.items).toHaveLength(25);
  });

  it("never returns secret-named keys or seeded secret values", async () => {
    const res = await run("e", auth(ALL_PERMISSIONS));
    const json = JSON.stringify(res);
    for (const secret of Object.values(SECRETS)) expect(json).not.toContain(secret);
    const secretKey = /secret|hash|password|token|apikey|api_key/i;
    for (const group of res.groups)
      for (const it of group.items) {
        for (const key of Object.keys(it)) expect(key).not.toMatch(secretKey);
        for (const [key, value] of Object.entries(it.meta ?? {})) {
          expect(key).not.toMatch(secretKey);
          for (const secret of Object.values(SECRETS)) expect(value).not.toContain(secret);
        }
      }
    // The session audit row is still findable, just without its id.
    const audit = await run("session", auth(["audit.read"]), "audit");
    expect(audit.groups[0]!.items[0]!.meta?.["resource"]).toBe("session");
  });
});

describe("searchTabVisibility", () => {
  it("opens zones/records on a zone grant and requests/audit on audit.read", () => {
    expect(
      searchTabVisibility(
        auth([], { zoneGrants: [{ serverId: "s", zoneName: "z.", permissions: ["zone.read"] }] }),
      ),
    ).toEqual({ zones: true, records: false, config: true, requests: false, audit: false });
    expect(searchTabVisibility(auth(["audit.read", "record.read"]))).toEqual({
      zones: false,
      records: true,
      config: true,
      requests: true,
      audit: true,
    });
  });
});
