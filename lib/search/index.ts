/**
 * lib/search/index.ts
 *
 * The global search: one query fuzzy-matched across zones, records, config
 * (settings, admin pages, backends, clusters, people, roles, templates,
 * sign-in providers), the PowerDNS request log and the audit log, filtered
 * per source by exactly the permission the matching page demands.
 *
 * Every source is checked on its own; nothing here trusts that a user who
 * can open the palette may see everything in it. Zone-scoped items go through
 * `canActOnZone` (a global grant OR a zone grant on that backend), admin items
 * through the global permission set, teams through the same per-team ability
 * check as the Teams page.
 *
 * What comes back is built from the narrow rows `SearchSources` hands over,
 * which hold no secrets (see `sources.ts`). Search never returns docs: the
 * palette links out to the website's search for those.
 *
 * Sources are injectable so the permission and scope rules are unit-tested
 * without a database or a PowerDNS backend.
 */

import "server-only";
import { canActOnZone, type ZoneGrantInput } from "@/lib/rbac/zone-permissions";
import { scoreMatch, type MatchRange, type ScoreOptions } from "./fuzzy";
import type {
  SearchGroup,
  SearchGroupKey,
  SearchItem,
  SearchItemKind,
  SearchResponse,
  SearchScope,
  SearchTabVisibility,
} from "./types";
import { LOG_GROUPS } from "./types";

export * from "./types";

/* ------------------------------------------------------------ source rows */

export interface ZoneSourceRow {
  name: string;
  serverId: string;
  serverSlug: string;
  serverName: string;
  clusterSlug: string | null;
  horizon: string;
  kind: string;
  /** Detail shown on the result, when the scan knows it. */
  dnssec?: boolean;
  serial?: number | null;
  /** RRsets in the zone; only when its detail has been read. */
  rrsetCount?: number;
}

export interface RecordSourceRow {
  zone: string;
  serverId: string;
  serverSlug: string;
  clusterSlug: string | null;
  name: string;
  type: string;
  contents: string[];
  /** Detail shown on the result, when the scan knows it. */
  horizon?: string;
  ttl?: number;
  /** How many of `contents` are disabled. */
  disabledCount?: number;
}

/**
 * Meta that says where a zone or record lives: its backend (a cluster or a
 * standalone server) and horizon, so two same-named hits are told apart.
 */
function placementMeta(row: {
  serverSlug: string;
  clusterSlug: string | null;
  horizon?: string;
}): Record<string, string> {
  return {
    backend: row.clusterSlug ?? row.serverSlug,
    backendType: row.clusterSlug ? "cluster" : "standalone",
    ...(row.horizon ? { horizon: row.horizon } : {}),
  };
}

export interface SearchSources {
  zones(): Promise<ZoneSourceRow[]>;
  records(): Promise<RecordSourceRow[]>;
  settings(): Promise<Array<{ key: string; label: string; value: string }>>;
  backends(): Promise<Array<{ id: string; slug: string; name: string; host: string }>>;
  clusters(): Promise<Array<{ id: string; slug: string; name: string }>>;
  users(): Promise<Array<{ id: string; name: string | null; email: string }>>;
  teams(): Promise<Array<{ id: string; slug: string; name: string }>>;
  roles(): Promise<Array<{ id: string; slug: string; name: string }>>;
  templates(): Promise<Array<{ id: string; slug: string; name: string }>>;
  authProviders(): Promise<
    Array<{ id: string; protocol: "oidc" | "saml" | "ldap"; slug: string; name: string }>
  >;
  requests(): Promise<
    Array<{
      id: string;
      ts: Date;
      op: string;
      method: string;
      path: string;
      status: number | null;
      serverSlug: string | null;
      requestId: string | null;
    }>
  >;
  audit(): Promise<
    Array<{
      id: string;
      ts: Date;
      actorType: "user" | "token" | "system";
      actorName: string | null;
      actorEmail: string | null;
      action: string;
      resourceType: string;
      resourceId: string | null;
      requestId: string | null;
    }>
  >;
}

/** The slice of the authenticated request the search decides with. */
export interface SearchAuth {
  globalPermissions: ReadonlySet<string>;
  zoneGrants: readonly ZoneGrantInput[];
  /** Per-team read check (the Teams page lets a team-scoped owner see their own teams). */
  canReadTeam: (teamId: string) => boolean;
  /** The opt-in pages that exist on this install; absent means none. */
  features?: SearchFeatures;
}

/** Which opt-in pages exist (REVERSE_DNS_ENABLED / ZONE_MONITOR_ENABLED). */
export interface SearchFeatures {
  reverseDns: boolean;
  zoneMonitoring: boolean;
}

/* ------------------------------------------------------------ constants */

/** Items per group when every group is shown. */
export const ALL_SCOPE_GROUP_LIMIT = 6;
/** Items when a single tab is open. */
export const SINGLE_SCOPE_LIMIT = 25;

const GROUP_LABELS: Record<SearchGroupKey, string> = {
  zones: "Zones",
  records: "Records",
  config: "Config",
  requests: "Requests",
  audit: "Audit",
};
const GROUP_ORDER: readonly SearchGroupKey[] = ["zones", "records", "config", "requests", "audit"];

/** Long values (TXT, URLs) contain most short subsequences; demand a tighter match there. */
const CONTENT_MATCH: ScoreOptions = { maxSpreadFactor: 2 };
const NAME_MATCH: ScoreOptions = { maxSpreadFactor: 4 };

/**
 * Audit rows whose resource id is itself a credential handle (a session id, an
 * API token id, a WebAuthn credential id) keep their type but lose the id.
 */
const AUDIT_RESOURCE_TYPES_WITHOUT_ID = new Set([
  "session",
  "api-token",
  "api_token",
  "token",
  "auth",
]);

/**
 * Admin pages matched by title. Each carries the permission its page checks
 * (`requireUserForPage({ can })`), so a page only shows to users it would
 * open for. `anyTeam` mirrors the Teams page, which also admits team-scoped
 * owners.
 */
interface ConfigPage {
  title: string;
  href: string;
  permission: string | null;
  keywords?: string;
  anyTeam?: boolean;
  /** Only listed when this opt-in feature is enabled. */
  feature?: keyof SearchFeatures;
}
const CONFIG_PAGES: readonly ConfigPage[] = [
  {
    title: "Settings",
    href: "/admin/settings",
    permission: "settings.read",
    keywords: "branding lockout ttl",
  },
  { title: "Backup & Restore", href: "/admin/settings/backup", permission: "system.backup" },
  {
    title: "Authentication",
    href: "/admin/authentication",
    permission: "auth.read",
    keywords: "sso sign-in",
  },
  {
    title: "Authentication: OIDC",
    href: "/admin/authentication",
    permission: "auth.read",
    keywords: "openid sso",
  },
  {
    title: "Authentication: SAML",
    href: "/admin/authentication",
    permission: "auth.read",
    keywords: "sso",
  },
  {
    title: "Authentication: LDAP",
    href: "/admin/authentication",
    permission: "auth.read",
    keywords: "active directory",
  },
  { title: "TSIG keys", href: "/admin/tsig-keys", permission: "tsig.read" },
  {
    title: "Autoprimaries",
    href: "/admin/autoprimaries",
    permission: "autoprimary.manage",
    keywords: "supermasters",
  },
  { title: "Zone templates", href: "/admin/zone-templates", permission: "template.use" },
  {
    title: "Import / Export",
    href: "/admin/import-export",
    permission: "zone.read",
    keywords: "zonefile bind",
  },
  { title: "Servers", href: "/admin/servers", permission: "server.read", keywords: "backends" },
  { title: "Clusters", href: "/admin/clusters", permission: "server.read", keywords: "groups" },
  { title: "Users", href: "/admin/users", permission: "user.read" },
  { title: "Teams", href: "/admin/teams", permission: "team.read", anyTeam: true },
  { title: "Roles", href: "/admin/roles", permission: "role.read", keywords: "permissions" },
  { title: "Audit log", href: "/admin/audit", permission: "audit.read" },
  {
    title: "Request log",
    href: "/admin/requests",
    permission: "audit.read",
    keywords: "powerdns http",
  },
  {
    title: "Reverse DNS",
    href: "/zones/auto-ptr",
    permission: "record.read",
    keywords: "ptr",
    feature: "reverseDns",
  },
  {
    title: "Zone Monitoring",
    href: "/zones/monitoring",
    permission: "zone.read",
    keywords: "delegation",
    feature: "zoneMonitoring",
  },
  {
    title: "Profile",
    href: "/profile",
    permission: null,
    keywords: "password mfa passkeys sessions",
  },
];

/* ------------------------------------------------------------ matching */

interface Field {
  text: string | undefined | null;
  /** Where the highlight goes when this field wins; `null` scores without highlighting. */
  target: "title" | "subtitle" | null;
  options?: ScoreOptions;
  /** Multiplier for a secondary field, so a title hit outranks the same hit elsewhere. */
  weight?: number;
}

interface FieldMatch {
  score: number;
  ranges: MatchRange[];
  subtitleRanges?: MatchRange[];
}

function matchFields(q: string, fields: readonly Field[]): FieldMatch | null {
  let best: { score: number; ranges: MatchRange[]; target: Field["target"] } | null = null;
  for (const f of fields) {
    if (!f.text) continue;
    const m = scoreMatch(q, f.text, f.options);
    if (!m) continue;
    const score = m.score * (f.weight ?? 1);
    if (!best || score > best.score) best = { score, ranges: m.ranges, target: f.target };
  }
  if (!best) return null;
  if (best.target === "title") return { score: best.score, ranges: best.ranges };
  if (best.target === "subtitle")
    return { score: best.score, ranges: [], subtitleRanges: best.ranges };
  return { score: best.score, ranges: [] };
}

interface ItemDraft {
  kind: SearchItemKind;
  title: string;
  subtitle?: string;
  meta?: Record<string, string>;
  href: string;
}

function item(group: SearchGroupKey, draft: ItemDraft, m: FieldMatch): SearchItem {
  const out: SearchItem = { ...draft, group, score: m.score, ranges: m.ranges };
  if (m.subtitleRanges && m.subtitleRanges.length > 0) out.subtitleRanges = m.subtitleRanges;
  return out;
}

function zoneHref(zone: string, serverSlug: string, clusterSlug: string | null, filter?: string) {
  // A cluster zone is addressed by its cluster: the page would redirect a peer
  // slug there anyway, and the redirect keeps only the tab.
  const where = clusterSlug
    ? `cluster=${encodeURIComponent(clusterSlug)}`
    : `server=${encodeURIComponent(serverSlug)}`;
  const q = filter ? `&q=${encodeURIComponent(filter)}` : "";
  return `/zones/${encodeURIComponent(zone)}?${where}${q}`;
}

/** Owner name as the record table shows it: relative to the zone, `@` at the apex. */
function relativeOwner(name: string, zone: string): string {
  if (name === zone) return "@";
  if (name.endsWith(`.${zone}`)) return name.slice(0, name.length - zone.length - 1);
  return name;
}

const withoutDot = (name: string): string => (name.endsWith(".") ? name.slice(0, -1) : name);

/* ------------------------------------------------------------ visibility */

const anyZoneGrantWith = (auth: SearchAuth, permission: string): boolean =>
  auth.zoneGrants.some((g) => g.permissions.includes(permission));

/**
 * Which tabs this user may see at all. Zones and Records open to a global
 * grant or any zone grant carrying the read permission; Config to any one of
 * the config permissions; Requests and Audit to `audit.read`.
 */
export function searchTabVisibility(auth: SearchAuth): SearchTabVisibility {
  const g = auth.globalPermissions;
  return {
    zones: g.has("zone.read") || anyZoneGrantWith(auth, "zone.read"),
    records: g.has("record.read") || anyZoneGrantWith(auth, "record.read"),
    config: true,
    requests: g.has("audit.read"),
    audit: g.has("audit.read"),
  };
}

/* ------------------------------------------------------------ per-source search */

type GroupResult = SearchItem[];

function zoneAllowed(auth: SearchAuth, permission: string, serverId: string, zone: string) {
  return canActOnZone({
    hasGlobalPermission: auth.globalPermissions.has(permission),
    grants: auth.zoneGrants,
    serverId,
    zoneName: zone,
    permission,
  });
}

async function searchZones(
  q: string,
  auth: SearchAuth,
  sources: SearchSources,
): Promise<GroupResult> {
  const out: GroupResult = [];
  const seen = new Set<string>();
  for (const z of await sources.zones()) {
    const key = `${z.serverId}|${z.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!zoneAllowed(auth, "zone.read", z.serverId, z.name)) continue;
    const title = withoutDot(z.name);
    const m = matchFields(q, [{ text: title, target: "title", options: NAME_MATCH }]);
    if (!m) continue;
    const backend = z.clusterSlug ?? z.serverSlug;
    out.push(
      item(
        "zones",
        {
          kind: "zone",
          title,
          subtitle: [z.kind, backend, z.horizon].filter(Boolean).join(" · "),
          meta: {
            ...placementMeta(z),
            kind: z.kind,
            ...(z.dnssec === undefined ? {} : { dnssec: z.dnssec ? "signed" : "unsigned" }),
            ...(z.serial == null ? {} : { serial: String(z.serial) }),
            ...(z.rrsetCount === undefined ? {} : { rrsets: String(z.rrsetCount) }),
          },
          href: zoneHref(z.name, z.serverSlug, z.clusterSlug),
        },
        m,
      ),
    );
  }
  return out;
}

async function searchRecords(
  q: string,
  auth: SearchAuth,
  sources: SearchSources,
): Promise<GroupResult> {
  const out: GroupResult = [];
  const allowed = new Map<string, boolean>();
  for (const rr of await sources.records()) {
    const zoneKey = `${rr.serverId}|${rr.zone}`;
    let ok = allowed.get(zoneKey);
    if (ok === undefined) {
      ok = zoneAllowed(auth, "record.read", rr.serverId, rr.zone);
      allowed.set(zoneKey, ok);
    }
    if (!ok) continue;
    const title = withoutDot(rr.name);
    const nameHit = scoreMatch(q, title, NAME_MATCH);
    let contentHit: { content: string; score: number; ranges: MatchRange[] } | null = null;
    for (const content of rr.contents) {
      const m = scoreMatch(q, content, CONTENT_MATCH);
      if (m && (!contentHit || m.score > contentHit.score)) contentHit = { content, ...m };
    }
    if (!nameHit && !contentHit) continue;
    const contentWins = contentHit !== null && (!nameHit || contentHit.score > nameHit.score);
    const content = contentHit?.content ?? rr.contents[0] ?? "";
    const more = rr.contents.length > 1 ? ` (+${rr.contents.length - 1})` : "";
    const match: FieldMatch = contentWins
      ? { score: contentHit!.score * 0.9, ranges: [], subtitleRanges: contentHit!.ranges }
      : { score: nameHit!.score, ranges: nameHit!.ranges };
    const filter = contentWins ? content : relativeOwner(rr.name, rr.zone);
    out.push(
      item(
        "records",
        {
          kind: "record",
          title,
          subtitle: content,
          meta: {
            type: rr.type,
            content: `${content}${more}`,
            zone: withoutDot(rr.zone),
            ...placementMeta(rr),
            ...(rr.ttl === undefined ? {} : { ttl: String(rr.ttl) }),
            ...(rr.contents.length > 1 ? { values: String(rr.contents.length) } : {}),
            ...(rr.disabledCount ? { disabled: String(rr.disabledCount) } : {}),
          },
          href: zoneHref(rr.zone, rr.serverSlug, rr.clusterSlug, filter),
        },
        match,
      ),
    );
  }
  return out;
}

async function searchConfig(
  q: string,
  auth: SearchAuth,
  sources: SearchSources,
): Promise<GroupResult> {
  const g = auth.globalPermissions;
  const out: GroupResult = [];
  const push = (draft: ItemDraft & { section: string; value?: string }, fields: Field[]) => {
    const m = matchFields(q, fields);
    if (!m) return;
    const { section, value, ...rest } = draft;
    out.push(item("config", { ...rest, meta: { section, value: value ?? "" } }, m));
  };

  const teams = g.has("team.read") ? null : await sources.teams();
  const anyTeamVisible = g.has("team.read") || (teams ?? []).some((t) => auth.canReadTeam(t.id));
  for (const page of CONFIG_PAGES) {
    if (page.feature && auth.features?.[page.feature] !== true) continue;
    const visible =
      page.permission === null ||
      g.has(page.permission) ||
      (page.anyTeam === true && anyTeamVisible);
    if (!visible) continue;
    push({ kind: "page", title: page.title, href: page.href, section: "Page" }, [
      { text: page.title, target: "title" },
      { text: page.keywords, target: null, weight: 0.6 },
    ]);
  }

  const reads: Array<Promise<void>> = [];
  if (g.has("settings.read"))
    reads.push(
      sources.settings().then((rows) => {
        for (const s of rows)
          push(
            {
              kind: "setting",
              title: s.label,
              subtitle: s.value || undefined,
              href: "/admin/settings",
              section: "Setting",
              value: s.value,
            },
            [
              { text: s.label, target: "title" },
              { text: s.key, target: null, weight: 0.9 },
              { text: s.value, target: "subtitle", options: CONTENT_MATCH, weight: 0.8 },
            ],
          );
      }),
    );
  if (g.has("server.read")) {
    const canEditServer = g.has("server.update");
    reads.push(
      sources.backends().then((rows) => {
        for (const b of rows)
          push(
            {
              kind: "backend",
              title: b.name,
              subtitle: b.host ? `${b.slug} · ${b.host}` : b.slug,
              href: canEditServer ? `/admin/servers/${b.id}` : "/admin/servers",
              section: "Backend",
              value: b.host,
            },
            [
              { text: b.name, target: "title" },
              { text: b.slug, target: null, weight: 0.9 },
              { text: b.host, target: null, weight: 0.8 },
            ],
          );
      }),
      sources.clusters().then((rows) => {
        for (const c of rows)
          push(
            {
              kind: "cluster",
              title: c.name,
              subtitle: c.slug,
              href: `/admin/clusters/${c.id}`,
              section: "Cluster",
              value: c.slug,
            },
            [
              { text: c.name, target: "title" },
              { text: c.slug, target: "subtitle", weight: 0.9 },
            ],
          );
      }),
    );
  }
  if (g.has("user.read"))
    reads.push(
      sources.users().then((rows) => {
        for (const u of rows)
          push(
            {
              kind: "user",
              title: u.name ?? u.email,
              subtitle: u.email,
              href: `/admin/users/${u.id}`,
              section: "User",
              value: u.email,
            },
            [
              { text: u.name, target: "title" },
              { text: u.email, target: u.name ? "subtitle" : "title", weight: 0.95 },
            ],
          );
      }),
    );
  if (g.has("team.read") || teams !== null)
    reads.push(
      (teams ? Promise.resolve(teams) : sources.teams()).then((rows) => {
        for (const t of rows) {
          if (!g.has("team.read") && !auth.canReadTeam(t.id)) continue;
          push(
            {
              kind: "team",
              title: t.name,
              subtitle: t.slug,
              href: `/admin/teams/${t.id}`,
              section: "Team",
              value: t.slug,
            },
            [
              { text: t.name, target: "title" },
              { text: t.slug, target: "subtitle", weight: 0.9 },
            ],
          );
        }
      }),
    );
  if (g.has("role.read"))
    reads.push(
      sources.roles().then((rows) => {
        for (const r of rows)
          push(
            {
              kind: "role",
              title: r.name,
              subtitle: r.slug,
              href: `/admin/roles/${r.id}`,
              section: "Role",
              value: r.slug,
            },
            [
              { text: r.name, target: "title" },
              { text: r.slug, target: "subtitle", weight: 0.9 },
            ],
          );
      }),
    );
  if (g.has("template.use"))
    reads.push(
      sources.templates().then((rows) => {
        for (const t of rows)
          push(
            {
              kind: "template",
              title: t.name,
              subtitle: t.slug,
              href: `/admin/zone-templates/${t.id}`,
              section: "Zone template",
              value: t.slug,
            },
            [
              { text: t.name, target: "title" },
              { text: t.slug, target: "subtitle", weight: 0.9 },
            ],
          );
      }),
    );
  if (g.has("auth.read"))
    reads.push(
      sources.authProviders().then((rows) => {
        for (const p of rows) {
          const protocol = p.protocol.toUpperCase();
          push(
            {
              kind: "auth-provider",
              title: p.name,
              subtitle: `${protocol} · ${p.slug}`,
              href: `/admin/authentication/${p.protocol}/${p.id}`,
              section: "Authentication",
              value: protocol,
            },
            [
              { text: p.name, target: "title" },
              { text: p.slug, target: null, weight: 0.9 },
              { text: protocol, target: null, weight: 0.5 },
            ],
          );
        }
      }),
    );
  await Promise.all(reads);
  return out;
}

async function searchRequests(
  q: string,
  auth: SearchAuth,
  sources: SearchSources,
): Promise<GroupResult> {
  if (!auth.globalPermissions.has("audit.read")) return [];
  const out: GroupResult = [];
  for (const r of await sources.requests()) {
    const title = `${r.method} ${r.path}`;
    const status = r.status === null ? "error" : String(r.status);
    const backend = r.serverSlug ?? "";
    const m = matchFields(q, [
      { text: title, target: "title", options: CONTENT_MATCH },
      { text: r.op, target: "subtitle", weight: 0.95 },
      { text: status, target: null, weight: 0.7 },
      { text: backend, target: null, weight: 0.7 },
    ]);
    if (!m) continue;
    const params = new URLSearchParams();
    if (r.requestId) params.set("requestId", r.requestId);
    else {
      params.set("op", r.op);
      if (r.serverSlug) params.set("serverSlug", r.serverSlug);
    }
    out.push(
      item(
        "requests",
        {
          kind: "request",
          title,
          subtitle: r.op,
          meta: { method: r.method, status, backend, time: r.ts.toISOString() },
          href: `/admin/requests?${params.toString()}`,
        },
        m,
      ),
    );
  }
  return out;
}

async function searchAudit(
  q: string,
  auth: SearchAuth,
  sources: SearchSources,
): Promise<GroupResult> {
  if (!auth.globalPermissions.has("audit.read")) return [];
  const out: GroupResult = [];
  for (const a of await sources.audit()) {
    const actor =
      a.actorType === "user"
        ? (a.actorName ?? a.actorEmail ?? "Deleted user")
        : a.actorType === "token"
          ? "API token"
          : "System";
    const resourceId = AUDIT_RESOURCE_TYPES_WITHOUT_ID.has(a.resourceType) ? null : a.resourceId;
    const resource = resourceId ? `${a.resourceType} ${resourceId}` : a.resourceType;
    const m = matchFields(q, [
      { text: a.action, target: "title" },
      { text: actor, target: null, weight: 0.9 },
      { text: a.actorType === "user" ? a.actorEmail : null, target: null, weight: 0.85 },
      { text: resource, target: null, options: CONTENT_MATCH, weight: 0.85 },
    ]);
    if (!m) continue;
    const params = new URLSearchParams({ action: a.action, resourceType: a.resourceType });
    if (resourceId) params.set("resourceId", resourceId);
    out.push(
      item(
        "audit",
        {
          kind: "audit",
          title: a.action,
          subtitle: `${actor} · ${resource}`,
          meta: { actor, resource, time: a.ts.toISOString() },
          href: `/admin/audit?${params.toString()}`,
        },
        m,
      ),
    );
  }
  return out;
}

const SEARCHERS: Record<
  SearchGroupKey,
  (q: string, auth: SearchAuth, sources: SearchSources) => Promise<GroupResult>
> = {
  zones: searchZones,
  records: searchRecords,
  config: searchConfig,
  requests: searchRequests,
  audit: searchAudit,
};

/* ------------------------------------------------------------ entry point */

export interface SearchEverythingInput {
  q: string;
  scope: SearchScope;
  auth: SearchAuth;
  /** Per-group cap; clamped to the scope's own (6 for `all`, 25 for a tab). */
  limit?: number;
  /** Data sources; the production ones when omitted. */
  sources?: SearchSources;
}

/**
 * Run one search across every source the user may read.
 *
 * Zones, records and config are matched for every scope, because the tab row
 * shows their counts; only the returned groups narrow to `scope`. The request
 * and audit logs are matched only when their own scope is chosen: "All" never
 * includes them, so the everyday search stays small and fast.
 *
 * @returns groups (non-empty ones, in tab order) and per-tab match counts.
 */
export async function searchEverything(input: SearchEverythingInput): Promise<SearchResponse> {
  const { q, scope, auth } = input;
  // Production queries read the prebuilt, hot-swapped snapshot: no I/O per keystroke.
  let sources: SearchSources;
  if (input.sources) {
    sources = input.sources;
  } else {
    const index = await import("./search-index");
    sources = index.snapshotSources(await index.getSearchSnapshot());
  }
  const cap = scope === "all" ? ALL_SCOPE_GROUP_LIMIT : SINGLE_SCOPE_LIMIT;
  const perGroup = Math.max(1, Math.min(input.limit ?? cap, cap));
  const visibility = searchTabVisibility(auth);

  const results = await Promise.all(
    GROUP_ORDER.map(async (key) => {
      if (LOG_GROUPS.has(key) && scope !== key) return { key, items: null };
      return visibility[key]
        ? { key, items: await SEARCHERS[key](q, auth, sources) }
        : { key, items: [] };
    }),
  );

  const counts: SearchResponse["counts"] = {
    zones: 0,
    records: 0,
    config: 0,
    requests: null,
    audit: null,
  };
  const groups: SearchGroup[] = [];
  for (const { key, items } of results) {
    if (items === null) continue;
    counts[key] = items.length;
    if (items.length === 0 || (scope !== "all" && scope !== key)) continue;
    items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    groups.push({
      key,
      label: GROUP_LABELS[key],
      total: items.length,
      items: items.slice(0, perGroup),
    });
  }
  return { q, scope, groups, counts };
}
