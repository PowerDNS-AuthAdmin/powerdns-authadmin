/**
 * lib/search/sources.ts
 *
 * The production data sources behind `searchEverything`. Each source reads
 * one kind of thing and maps it straight to a narrow row shape that holds
 * only searchable, displayable fields: the secrets that live next to these
 * rows (password hashes, API keys, client secrets, bind passwords, signing
 * keys, request headers and bodies, audit snapshots) are either never
 * selected or dropped on the line that reads them, so nothing downstream can
 * leak them by accident.
 *
 * Authorization is NOT applied here: rows are filtered per user in
 * `lib/search/index.ts`. That is what lets the short memo below be shared by
 * every caller, which keeps a palette typed at full speed from re-reading the
 * same tables on each keystroke.
 */

import "server-only";
import { cachedZoneDetails, getFleetScan } from "@/app/api/admin/pdns/auto-ptr/_scan";
import { listRecentAuditSummaries } from "@/lib/db/repositories/audit";
import { listAllLdapProviders } from "@/lib/db/repositories/ldap-providers";
import { listAllClusters } from "@/lib/db/repositories/pdns-clusters";
import { listRecentPdnsRequestSummaries } from "@/lib/db/repositories/pdns-requests";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { listUserDirectory } from "@/lib/db/repositories/users";
import { listAllZoneTemplates } from "@/lib/db/repositories/zone-templates";
import { listAllOidcProviders } from "@/lib/db/repositories/oidc-providers";
import { listAllSamlProviders } from "@/lib/db/repositories/saml-providers";
import { getAppSettings } from "@/lib/settings/app-settings";
import type { SearchSources } from "./index";

/** The request log and audit log are matched over this many newest rows. */
export const LOG_WINDOW_ROWS = 500;
/**
 * Share one in-flight read between callers (zones and records come from the
 * same fleet read). Nothing is kept after it settles: the search index
 * (search-index.ts) is the cache, and a rebuild must see the newest data.
 */
function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? "";
  }
}

const clusterSlugs = memo(async () => {
  const clusters = await listAllClusters();
  return new Map(clusters.map((c) => [c.id, c.slug]));
});

const fleet = memo(async () => {
  const [scan, slugs] = await Promise.all([
    // A rebuild follows a change, so ask for a fresh scan (the scan itself
    // rate-limits refreshes and reuses unchanged zones' details).
    getFleetScan({ refresh: true }),
    clusterSlugs(),
  ]);
  const byId = new Map(scan.servers.map((s) => [s.id, s]));
  const bySlug = new Map(scan.servers.map((s) => [s.slug, s]));
  const zones = scan.zones.flatMap((z) => {
    const server = bySlug.get(z.server);
    if (!server) return [];
    return [
      {
        name: z.name,
        serverId: server.id,
        serverSlug: server.slug,
        serverName: server.name,
        clusterSlug: server.clusterId ? (slugs.get(server.clusterId) ?? null) : null,
        horizon: z.horizon,
        kind: z.kind,
      },
    ];
  });
  const records = cachedZoneDetails().flatMap((entry) => {
    const server = byId.get(entry.serverId);
    if (!server) return [];
    const clusterSlug = server.clusterId ? (slugs.get(server.clusterId) ?? null) : null;
    return (entry.detail.rrsets ?? []).map((rr) => ({
      zone: entry.zone,
      serverId: server.id,
      serverSlug: server.slug,
      clusterSlug,
      name: rr.name,
      type: rr.type,
      contents: rr.records.map((r) => r.content),
    }));
  });
  return { zones, records };
});

/** The real sources: fleet scan, app database and the settings cache. */
export const defaultSearchSources: SearchSources = {
  zones: async () => (await fleet()).zones,
  records: async () => (await fleet()).records,
  settings: memo(async () => {
    const s = await getAppSettings();
    return [
      { key: "site_name", label: "Site name", value: s.siteName },
      { key: "brand_logo_url", label: "Brand logo URL", value: s.brandLogoUrl ?? "" },
      { key: "support_contact", label: "Support contact", value: s.supportContact ?? "" },
      { key: "login_intro", label: "Login intro text", value: s.loginIntro ?? "" },
      {
        key: "login_lockout_threshold",
        label: "Login lockout threshold",
        value: String(s.loginLockoutThreshold),
      },
      {
        key: "login_lockout_seconds",
        label: "Login lockout duration (seconds)",
        value: String(s.loginLockoutSeconds),
      },
      {
        key: "allow_password_reset",
        label: "Allow password reset",
        value: s.allowPasswordReset ? "on" : "off",
      },
      {
        key: "auth_default_provider",
        label: "Default sign-in method",
        value: s.authDefaultProvider,
      },
      { key: "default_record_ttl", label: "Default record TTL", value: String(s.defaultRecordTtl) },
      { key: "auto_ptr", label: "Automatic PTR records", value: s.autoPtr ? "on" : "off" },
    ];
  }),
  backends: memo(async () =>
    (await listAllPdnsServers()).map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      host: hostOf(s.baseUrl),
    })),
  ),
  clusters: memo(async () =>
    (await listAllClusters()).map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
  ),
  users: memo(() => listUserDirectory()),
  teams: memo(async () =>
    (await listAllTeams()).map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
  ),
  roles: memo(async () =>
    (await listRoles()).map((r) => ({ id: r.id, slug: r.slug, name: r.name })),
  ),
  templates: memo(async () =>
    (await listAllZoneTemplates()).map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
  ),
  authProviders: memo(async () => {
    const [oidc, saml, ldap] = await Promise.all([
      listAllOidcProviders(),
      listAllSamlProviders(),
      listAllLdapProviders(),
    ]);
    return [
      ...oidc.map((p) => ({ id: p.id, protocol: "oidc" as const, slug: p.slug, name: p.name })),
      ...saml.map((p) => ({ id: p.id, protocol: "saml" as const, slug: p.slug, name: p.name })),
      ...ldap.map((p) => ({ id: p.id, protocol: "ldap" as const, slug: p.slug, name: p.name })),
    ];
  }),
  requests: memo(async () =>
    (await listRecentPdnsRequestSummaries(LOG_WINDOW_ROWS)).map((r) => ({
      id: r.id,
      ts: r.ts,
      op: r.op,
      method: r.method,
      // Path only: the host is the backend's (internal) address and the query
      // string is never needed to recognise a call.
      path: pathOf(r.url),
      status: r.responseStatus,
      serverSlug: r.serverSlug,
      requestId: r.requestId,
    })),
  ),
  audit: memo(() => listRecentAuditSummaries(LOG_WINDOW_ROWS)),
};
