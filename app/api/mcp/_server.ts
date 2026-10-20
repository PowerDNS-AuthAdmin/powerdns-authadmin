/**
 * app/api/mcp/_server.ts
 *
 * The Model Context Protocol server behind `POST /api/mcp`. Built once per
 * request around the caller's authenticated context, so every tool runs as
 * that user: reads go through the same `canActOnZone` gate the pages use,
 * writes are dispatched into the existing REST route handlers (see
 * `_dispatch.ts`) and therefore inherit RBAC ceilings, validation, optimistic
 * concurrency, audit and NOTIFY unchanged.
 *
 * Tool surface is deliberately small and task-shaped (what an operator
 * types into an assistant), not a mirror of the PowerDNS API:
 *
 *   list_backends     which PowerDNS backends exist (slug to pass elsewhere)
 *   list_zones        zones the caller may read, across backends
 *   get_zone          one zone's summary (kind, serial, DNSSEC, counts)
 *   list_records      records of a zone, filterable by name/type
 *   search            fuzzy search over zones, records, config, request + audit log
 *   set_records       REPLACE every value of one name+type
 *   add_record        append one value to a name+type
 *   delete_records    remove one value, or the whole name+type
 *   create_zone       create a zone (optionally from the defaults)
 *   delete_zone       delete a zone (requires the name typed as `confirm`)
 *
 * Write tools are only advertised when the caller holds a write
 * permission somewhere, so a read-only token sees a read-only server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuthenticatedRequest } from "@/lib/auth/get-current-user";
import type { PdnsServer } from "@/lib/db/schema";
import {
  findDefaultPdnsServer,
  findPdnsServerBySlug,
  listActivePdnsServers,
} from "@/lib/db/repositories/pdns-servers";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { redact } from "@/lib/errors/redact";
import { PdnsError } from "@/lib/pdns/errors";
import { logger } from "@/lib/logger";
import {
  DispatchError,
  dispatchCreateZone,
  dispatchDeleteZone,
  dispatchPatchRrsets,
  type RRsetChange,
} from "./_dispatch";
import {
  dispatchMonitoring,
  dispatchMonitoringRefresh,
  dispatchNotifications,
  dispatchDismissNotifications,
  dispatchRecordsAt,
  dispatchReverseLinks,
  dispatchReverseRectify,
  dispatchReverseReport,
  dispatchSearch,
  dispatchSearchZones,
  dispatchZoneSync,
} from "./_dispatch";
import { canonicalName, canonicalZone, filterRows, flattenRrsets } from "./_records";
import { describePtrOutcome, type AutoPtrOutcome } from "@/lib/dns/auto-ptr";

export interface McpContext {
  request: Request;
  auth: AuthenticatedRequest;
}

const SERVER_NAME = "powerdns-authadmin";
const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `You manage DNS zones hosted on PowerDNS through PowerDNS-AuthAdmin.
Conventions:
- Zone names may be given with or without the trailing dot ("example.com" or "example.com.").
- Record names are relative to the zone ("www", "_acme-challenge") or absolute with a trailing dot; "@" means the zone apex.
- A name+type pair (an RRset) holds one or more values. set_records REPLACES all of them; add_record appends one; delete_records removes one value or the whole set.
- TTL is in seconds. When omitted on a new RRset the deployment's default TTL applies; when editing an existing RRset its current TTL is kept.
- TXT values must be quoted ("v=spf1 -all"); MX values are "<preference> <host.>"; hostnames should end with a dot.
- Installations with several backends need a backend slug: call list_backends once, then pass server_slug. The default backend is used when omitted.
- Every write is authorised against the token's permissions and recorded in the audit log under the token owner's name. Prefer list_records before changing anything so you replace exactly what you intend.
- search is a fuzzy lookup across zones, records, config, the PowerDNS request log and the audit log (scope narrows it); results carry an app link and never include secrets.
- find_zones searches every zone the token may read (with backend, cluster, horizon); records_at tells whether a name already holds records before you add one; zone_sync_status says whether a change has reached every secondary or cluster peer, so poll it after a write when propagation matters.
- reverse_dns_report lists every A/AAAA address against its PTR (ok, missing, mismatch, ambiguous, orphan, unhosted) and reverse_dns_rectify writes or removes the PTRs you choose; zone_monitoring returns the latest delegation / nameserver / DNSSEC / resolver findings per zone and zone_monitoring_refresh re-runs the checks (rate-limited).
- Reverse DNS: when an A/AAAA record is written or deleted, the matching PTR in a reverse zone hosted here can be maintained automatically. Pass ptr=true to ask for it, ptr=false to prevent it, or omit it to follow the zone's / the deployment's auto_ptr setting. The result's "ptr" list says what happened per address; a PTR that already points at a different name is reported as a conflict and only replaced when ptr_takeover=true. Reverse zones are never created.`;

const zoneArg = z
  .string()
  .min(1)
  .describe('Zone name, e.g. "example.com" (trailing dot optional).');
const serverArg = z
  .string()
  .min(1)
  .optional()
  .describe("Backend slug from list_backends. Omit to use the default backend.");
const nameArg = z
  .string()
  .describe(
    'Record name relative to the zone ("www"), absolute with a trailing dot, or "@" for the apex.',
  );
const typeArg = z
  .string()
  .min(1)
  .max(12)
  .describe("Record type, e.g. A, AAAA, CNAME, MX, TXT, SRV, CAA.");
const ttlArg = z.number().int().min(0).max(2_147_483_647).optional().describe("TTL in seconds.");
const ptrArg = z
  .boolean()
  .optional()
  .describe(
    "A/AAAA only: also create, update or remove the matching PTR in a hosted reverse zone. Omit to follow the zone's auto_ptr setting.",
  );
const ptrTakeoverArg = z
  .boolean()
  .optional()
  .describe("With ptr: replace a PTR that currently points at a different name. Default false.");

/**
 * Lift the route's per-address PTR outcomes into one readable line each, so the
 * assistant can tell the operator about a skipped or conflicting reverse record
 * without parsing the raw result.
 */
function ptrSummary(result: unknown): { ptr?: string[] } {
  const ptr = (result as { ptr?: AutoPtrOutcome[] } | null)?.ptr;
  if (!Array.isArray(ptr) || ptr.length === 0) return {};
  return { ptr: ptr.map(describePtrOutcome) };
}

function text(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function failure(err: unknown): CallToolResult {
  let message: string;
  let status: number | undefined;
  if (err instanceof DispatchError) {
    status = err.status;
    const body = err.body as { error?: unknown; fieldErrors?: unknown } | string | null;
    message =
      typeof body === "object" && body !== null && typeof body.error === "string"
        ? body.error
        : `Request failed with HTTP ${err.status}.`;
    if (typeof body === "object" && body?.fieldErrors) {
      message += ` ${JSON.stringify(body.fieldErrors)}`;
    }
  } else if (
    err instanceof ForbiddenError ||
    err instanceof NotFoundError ||
    err instanceof ValidationError
  ) {
    message = err.message;
  } else if (err instanceof PdnsError) {
    message = `PowerDNS: ${redact(err.message)}`;
  } else {
    logger.error({ err }, "mcp.tool.unexpected-error");
    message = "Internal error. Check the server log.";
  }
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: message, ...(status ? { status } : {}) }) },
    ],
  };
}

/** Wrap a tool body so every failure becomes a tool error, never a transport error. */
function tool<T>(
  run: (input: T) => Promise<CallToolResult>,
): (input: T) => Promise<CallToolResult> {
  return async (input) => {
    try {
      return await run(input);
    } catch (err) {
      return failure(err);
    }
  };
}

export function buildMcpServer(ctx: McpContext): McpServer {
  const { auth, request } = ctx;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const zoneCan = (serverId: string, zone: string, permission: string): boolean =>
    canActOnZone({
      hasGlobalPermission: auth.globalPermissions.has(permission),
      grants: auth.zoneGrants,
      serverId,
      zoneName: zone,
      permission,
    });

  async function resolveServer(slug: string | undefined): Promise<PdnsServer> {
    const selected = slug ? await findPdnsServerBySlug(slug) : await findDefaultPdnsServer();
    if (selected?.disabledAt !== null) {
      throw new NotFoundError(
        slug ? `Unknown or disabled backend "${slug}".` : "No default backend is configured.",
      );
    }
    return selected;
  }

  async function readZone(zoneInput: string, slug: string | undefined) {
    const zone = canonicalZone(zoneInput);
    const selected = await resolveServer(slug);
    if (!zoneCan(selected.id, zone, "zone.read")) {
      throw new ForbiddenError(`You don't have zone.read on ${zone}.`);
    }
    const detail = await getBackendGateway(selected).getZone(zone);
    return { zone, selected, detail };
  }

  // ── Read tools ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_backends",
    {
      title: "List PowerDNS backends",
      description:
        "List the PowerDNS backends this installation manages. Use the slug as server_slug on other tools when there is more than one.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async () => {
      const servers = await listActivePdnsServers();
      return text(
        servers.map((s) => ({
          slug: s.slug,
          name: s.name,
          isDefault: s.isDefault,
          writeMode: s.writeMode,
          cluster: s.clusterId ?? null,
        })),
      );
    }),
  );

  server.registerTool(
    "list_zones",
    {
      title: "List zones",
      description:
        "List the zones the caller may read, optionally on one backend and/or matching a substring. Returns name, kind and backend slug.",
      inputSchema: {
        server_slug: serverArg,
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring to match zone names against."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ server_slug, query }) => {
      const servers = server_slug
        ? [await resolveServer(server_slug)]
        : await listActivePdnsServers();
      const needle = query?.trim().toLowerCase();
      const out: Array<{ name: string; kind: string; server: string; serial?: number }> = [];
      for (const s of servers) {
        let zones;
        try {
          zones = await getBackendGateway(s).listZones();
        } catch (err) {
          logger.warn({ err, server: s.slug }, "mcp.list_zones.backend-unreachable");
          continue;
        }
        for (const zn of zones) {
          if (!zoneCan(s.id, zn.name, "zone.read")) continue;
          if (needle && !zn.name.toLowerCase().includes(needle)) continue;
          out.push({ name: zn.name, kind: zn.kind, server: s.slug, serial: zn.serial });
        }
      }
      return text({ zones: out, total: out.length });
    }),
  );

  server.registerTool(
    "get_zone",
    {
      title: "Get zone summary",
      description:
        "Summary of one zone: kind, serial, DNSSEC state, record counts by type, nameservers.",
      inputSchema: { zone: zoneArg, server_slug: serverArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug }) => {
      const { zone, selected, detail } = await readZone(zoneInput, server_slug);
      const rrsets = detail.rrsets ?? [];
      const countsByType: Record<string, number> = {};
      for (const rr of rrsets)
        countsByType[rr.type] = (countsByType[rr.type] ?? 0) + rr.records.length;
      const ns =
        rrsets.find((rr) => rr.type === "NS" && rr.name === zone)?.records.map((r) => r.content) ??
        [];
      return text({
        name: zone,
        server: selected.slug,
        kind: detail.kind,
        serial: detail.serial,
        dnssec: detail.dnssec ?? false,
        nameservers: ns,
        rrsetCount: rrsets.length,
        recordCount: Object.values(countsByType).reduce((a, b) => a + b, 0),
        countsByType,
      });
    }),
  );

  server.registerTool(
    "list_records",
    {
      title: "List records",
      description:
        "Records of a zone, one row per value, optionally filtered by name and/or type. Paginated with limit/offset for large zones.",
      inputSchema: {
        zone: zoneArg,
        server_slug: serverArg,
        name: nameArg.optional(),
        type: typeArg.optional(),
        limit: z.number().int().min(1).max(1000).default(200),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug, name, type, limit, offset }) => {
      const { zone, selected, detail } = await readZone(zoneInput, server_slug);
      const rows = filterRows(flattenRrsets(detail.rrsets ?? []), { zone, name, type });
      return text({
        zone,
        server: selected.slug,
        total: rows.length,
        offset,
        records: rows.slice(offset, offset + limit),
      });
    }),
  );

  // ── Write tools ────────────────────────────────────────────────────────

  const WRITE_PERMISSIONS = [
    "record.create",
    "record.update",
    "record.delete",
    "zone.create",
    "zone.delete",
  ];
  // ── Discovery, propagation, reverse DNS and monitoring (read) ─────────────

  server.registerTool(
    "find_zones",
    {
      title: "Find zones",
      description:
        "Search the zones this token may read across every backend. Returns name, backend slug, cluster, horizon (public/internal), kind, whether it is a reverse zone and whether you may create records in it. Also reports how many public and internal zones exist.",
      inputSchema: {
        query: z.string().max(255).optional().describe("Substring of the zone name; omit for all."),
        horizon: z.enum(["public", "internal"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ query, horizon, limit }) =>
      text(await dispatchSearchZones(request, { q: query, horizon, limit })),
    ),
  );

  server.registerTool(
    "search",
    {
      title: "Search everything",
      description:
        "Fuzzy search across zones, records (owner names and values), config (settings, admin pages, backends, clusters, users, teams, roles, zone templates, sign-in providers), the PowerDNS request log and the audit log. Each result has a kind, title, inline meta and an app link; every source is filtered by this token's permissions and secrets are never returned. Requests and audit cover the newest 500 rows.",
      inputSchema: {
        query: z.string().min(1).max(100).describe("What to look for; fuzzy, case-insensitive."),
        scope: z
          .enum(["all", "zones", "records", "config", "requests", "audit"])
          .optional()
          .describe("Narrow to one kind of result. Defaults to all (6 per group)."),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ query, scope, limit }) =>
      text(await dispatchSearch(request, { q: query, scope, limit })),
    ),
  );

  server.registerTool(
    "records_at",
    {
      title: "Records at a name",
      description:
        "The RRsets that exist at one owner name in a zone (optionally one type), for checking whether a record already exists before adding one.",
      inputSchema: {
        zone: zoneArg,
        server_slug: serverArg,
        name: nameArg,
        type: typeArg.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ zone, server_slug, name, type }) =>
      text(
        await dispatchRecordsAt(request, {
          zone: canonicalZone(zone),
          serverSlug: server_slug,
          name,
          type,
        }),
      ),
    ),
  );

  server.registerTool(
    "zone_sync_status",
    {
      title: "Zone propagation status",
      description:
        "Where a zone's copies stand: each secondary's serial against the primary, or each cluster peer against the highest serial. `settled` is true when nothing is behind. Poll it after a write when propagation matters.",
      inputSchema: { zone: zoneArg, server_slug: serverArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ zone, server_slug }) =>
      text(await dispatchZoneSync(request, { zone: canonicalZone(zone), serverSlug: server_slug })),
    ),
  );

  server.registerTool(
    "reverse_dns_report",
    {
      title: "Reverse DNS report",
      description:
        "Every A/AAAA address across the fleet against the PTR in the hosted reverse zones: ok, missing, mismatch, ambiguous (several names share the address), orphan (PTR with no forward record) or unhosted (no reverse zone here; the world's answer is included when known). Needs global record.read.",
      inputSchema: {
        status: z.enum(["ok", "missing", "mismatch", "ambiguous", "orphan", "unhosted"]).optional(),
        horizon: z.enum(["public", "internal"]).optional(),
        zone: z.string().optional().describe("Only addresses with a forward record in this zone."),
        limit: z.number().int().min(1).max(1000).optional().describe("Default 200."),
        refresh: z.boolean().optional().describe("Ask for a fresh scan (rate-limited)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ status, horizon, zone, limit, refresh }) => {
      const report = (await dispatchReverseReport(request, refresh === true)) as {
        generatedAt: string;
        stats: Record<string, number>;
        rows: Array<
          { status: string; horizon: string; forward: Array<{ zone: string }> } & Record<
            string,
            unknown
          >
        >;
        errors: unknown[];
      };
      const wantZone = zone ? canonicalZone(zone) : null;
      const rows = report.rows.filter(
        (r) =>
          (!status || r.status === status) &&
          (!horizon || r.horizon === horizon) &&
          (!wantZone || r.forward.some((f) => f.zone === wantZone)),
      );
      return text({
        generatedAt: report.generatedAt,
        stats: report.stats,
        matched: rows.length,
        rows: rows.slice(0, limit ?? 200),
        errors: report.errors,
      });
    }),
  );

  server.registerTool(
    "reverse_dns_links",
    {
      title: "Reverse DNS links for a zone",
      description:
        "For a forward zone: what the PTR of each A/AAAA address says. For a reverse zone: which A/AAAA records point at each PTR's address. Only zones the token may read are named.",
      inputSchema: { zone: zoneArg, server_slug: serverArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ zone, server_slug }) =>
      text(
        await dispatchReverseLinks(request, { zone: canonicalZone(zone), serverSlug: server_slug }),
      ),
    ),
  );

  server.registerTool(
    "zone_monitoring",
    {
      title: "Zone monitoring findings",
      description:
        "The latest zone monitoring results: per zone, the delegation at the parent, nameserver reachability and authority, serial agreement, open zone transfers, DNSSEC chain, resolver view, SOA sanity and reverse-DNS drift, as findings with stable codes and severities. Needs global zone.read.",
      inputSchema: {
        zone: z.string().optional(),
        server_slug: serverArg,
        severity: z
          .enum(["error", "warn", "info"])
          .optional()
          .describe("Only zones whose worst finding is this severity."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ zone, server_slug, severity }) => {
      const state = (await dispatchMonitoring(request)) as {
        results: Array<
          { zone: string; server: string; severity: string | null } & Record<string, unknown>
        >;
      } & Record<string, unknown>;
      const wantZone = zone ? canonicalZone(zone) : null;
      const results = state.results.filter(
        (r) =>
          (!wantZone || r.zone === wantZone) &&
          (!server_slug || r.server === server_slug) &&
          (!severity || r.severity === severity),
      );
      return text({ ...state, results });
    }),
  );

  server.registerTool(
    "zone_monitoring_refresh",
    {
      title: "Re-run zone monitoring",
      description:
        "Run the monitoring checks now for one zone (zone + server_slug) or for every zone (no arguments). Rate-limited: a refused run answers with the retry interval.",
      inputSchema: { zone: z.string().optional(), server_slug: serverArg },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    tool(async ({ zone, server_slug }) =>
      text(
        await dispatchMonitoringRefresh(
          request,
          zone ? { zone: canonicalZone(zone), serverSlug: server_slug } : {},
        ),
      ),
    ),
  );

  server.registerTool(
    "list_notifications",
    {
      title: "Notifications",
      description:
        "The notifications this token may see: backend health and zone monitoring findings, errors first, with a count by severity. Each row is filtered by its own scope (a zone finding needs zone.read on that zone). Pass include_dismissed to list dismissed ones too.",
      inputSchema: {
        include_dismissed: z.boolean().optional(),
        severity: z.enum(["error", "warn", "info"]).optional(),
        source: z.enum(["backend", "zone"]).optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ include_dismissed, severity, source, limit }) => {
      const body = (await dispatchNotifications(request, include_dismissed === true)) as {
        summary: unknown;
        notifications: Array<{ severity: string; source: string } & Record<string, unknown>>;
      };
      const rows = body.notifications.filter(
        (n) => (!severity || n.severity === severity) && (!source || n.source === source),
      );
      return text({
        summary: body.summary,
        matched: rows.length,
        notifications: rows.slice(0, limit ?? 100),
      });
    }),
  );

  // Dismissing is not a DNS change: anyone who can see a notification may
  // dismiss it, so this sits with the read tools rather than behind the write gate.
  server.registerTool(
    "dismiss_notifications",
    {
      title: "Dismiss notifications",
      description:
        "Dismiss notifications by id (from list_notifications). A dismissed notification leaves the bell until its condition changes or comes back. Ids the token cannot see are skipped.",
      inputSchema: { ids: z.array(z.string().min(1).max(64)).min(1).max(500) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(async ({ ids }) => text(await dispatchDismissNotifications(request, ids))),
  );

  const canWriteSomewhere =
    WRITE_PERMISSIONS.some((p) => auth.globalPermissions.has(p)) ||
    auth.zoneGrants.some((g) => g.permissions.some((p) => p.startsWith("record.")));
  if (!canWriteSomewhere) return server;

  const recordValue = z.object({
    content: z
      .string()
      .min(1)
      .describe("Record value in zone-file syntax (TXT quoted, MX with preference)."),
    disabled: z.boolean().optional().describe("Keep the record but stop serving it."),
  });

  server.registerTool(
    "set_records",
    {
      title: "Set records (replace)",
      description:
        "REPLACE every value of one name+type with the given list. Use list_records first; to add a single value without touching the others use add_record.",
      inputSchema: {
        zone: zoneArg,
        server_slug: serverArg,
        name: nameArg,
        type: typeArg,
        records: z.array(recordValue).min(1).max(1000),
        ttl: ttlArg,
        comment: z.string().max(1000).optional().describe("Free-form note stored on the RRset."),
        ptr: ptrArg,
        ptr_takeover: ptrTakeoverArg,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(
      async ({
        zone: zoneInput,
        server_slug,
        name,
        type,
        records,
        ttl,
        comment,
        ptr,
        ptr_takeover,
      }) => {
        const { zone, selected, detail } = await readZone(zoneInput, server_slug);
        const owner = canonicalName(name, zone);
        const rtype = type.trim().toUpperCase();
        const existing = (detail.rrsets ?? []).find((rr) => rr.name === owner && rr.type === rtype);
        const change: RRsetChange = {
          kind: "upsert",
          name: owner,
          type: rtype,
          records,
          ...(ttl !== undefined ? { ttl } : existing ? { ttl: existing.ttl } : {}),
          ...(comment !== undefined ? { comment } : {}),
          ...(ptr !== undefined ? { ptr } : {}),
          ...(ptr_takeover !== undefined ? { ptrTakeover: ptr_takeover } : {}),
        };
        const result = await dispatchPatchRrsets(request, {
          zone,
          serverSlug: selected.slug,
          changes: [change],
        });
        return text({
          ok: true,
          zone,
          server: selected.slug,
          name: owner,
          type: rtype,
          records,
          ...ptrSummary(result),
          result,
        });
      },
    ),
  );

  server.registerTool(
    "add_record",
    {
      title: "Add a record value",
      description:
        "Append one value to a name+type, creating the RRset if needed. Existing values are kept.",
      inputSchema: {
        zone: zoneArg,
        server_slug: serverArg,
        name: nameArg,
        type: typeArg,
        content: z.string().min(1).describe("Record value in zone-file syntax."),
        ttl: ttlArg,
        ptr: ptrArg,
        ptr_takeover: ptrTakeoverArg,
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug, name, type, content, ttl, ptr, ptr_takeover }) => {
      const { zone, selected, detail } = await readZone(zoneInput, server_slug);
      const owner = canonicalName(name, zone);
      const rtype = type.trim().toUpperCase();
      const existing = (detail.rrsets ?? []).find((rr) => rr.name === owner && rr.type === rtype);
      const current = existing?.records ?? [];
      if (current.some((r) => r.content === content)) {
        return text({ ok: true, unchanged: true, zone, name: owner, type: rtype, content });
      }
      const change: RRsetChange = {
        kind: "upsert",
        name: owner,
        type: rtype,
        records: [...current, { content }],
        ...(ttl !== undefined ? { ttl } : existing ? { ttl: existing.ttl } : {}),
        ...(ptr !== undefined ? { ptr } : {}),
        ...(ptr_takeover !== undefined ? { ptrTakeover: ptr_takeover } : {}),
      };
      const result = await dispatchPatchRrsets(request, {
        zone,
        serverSlug: selected.slug,
        changes: [change],
      });
      return text({
        ok: true,
        zone,
        server: selected.slug,
        name: owner,
        type: rtype,
        records: change.records,
        ...ptrSummary(result),
        result,
      });
    }),
  );

  server.registerTool(
    "delete_records",
    {
      title: "Delete records",
      description:
        "Remove one value of a name+type (pass content), or the whole name+type (omit content).",
      inputSchema: {
        zone: zoneArg,
        server_slug: serverArg,
        name: nameArg,
        type: typeArg,
        content: z
          .string()
          .optional()
          .describe("The exact value to remove. Omit to remove every value of this name+type."),
        ptr: ptrArg,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug, name, type, content, ptr }) => {
      const { zone, selected, detail } = await readZone(zoneInput, server_slug);
      const owner = canonicalName(name, zone);
      const rtype = type.trim().toUpperCase();
      const existing = (detail.rrsets ?? []).find((rr) => rr.name === owner && rr.type === rtype);
      if (!existing) throw new NotFoundError(`No ${rtype} records at ${owner}.`);
      let change: RRsetChange;
      if (content === undefined) {
        change = { kind: "delete", name: owner, type: rtype };
      } else {
        const remaining = existing.records.filter((r) => r.content !== content);
        if (remaining.length === existing.records.length) {
          throw new NotFoundError(`No ${rtype} value "${content}" at ${owner}.`);
        }
        change =
          remaining.length === 0
            ? { kind: "delete", name: owner, type: rtype }
            : { kind: "upsert", name: owner, type: rtype, ttl: existing.ttl, records: remaining };
      }
      if (ptr !== undefined) change.ptr = ptr;
      const result = await dispatchPatchRrsets(request, {
        zone,
        serverSlug: selected.slug,
        changes: [change],
      });
      return text({
        ok: true,
        zone,
        server: selected.slug,
        name: owner,
        type: rtype,
        change: change.kind,
        ...ptrSummary(result),
        result,
      });
    }),
  );

  server.registerTool(
    "reverse_dns_rectify",
    {
      title: "Rectify reverse DNS",
      description:
        "Write or remove PTRs chosen from reverse_dns_report. `set` writes the PTR for the address to `target` (replacing one that points elsewhere, because you chose it); `remove` removes a PTR that still points at `target`. Each item needs record permissions in the reverse zone; the result lists what happened per address.",
      inputSchema: {
        items: z
          .array(
            z.object({
              ip: z.string().min(1).max(64),
              action: z.enum(["set", "remove"]),
              target: z
                .string()
                .min(1)
                .max(255)
                .describe("Forward name to point at (set) or the current target (remove)."),
              ttl: ttlArg,
            }),
          )
          .min(1)
          .max(500),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ items }) => {
      const result = (await dispatchReverseRectify(request, { items })) as {
        outcomes: AutoPtrOutcome[];
      };
      return text({
        ok: true,
        outcomes: result.outcomes,
        lines: result.outcomes.map(describePtrOutcome),
      });
    }),
  );

  server.registerTool(
    "create_zone",
    {
      title: "Create zone",
      description:
        "Create a zone on a backend. Nameservers default to the deployment's template when omitted; kind defaults to Native.",
      inputSchema: {
        name: zoneArg,
        server_slug: serverArg,
        kind: z.enum(["Native", "Primary", "Secondary"]).default("Native"),
        nameservers: z
          .array(z.string())
          .max(13)
          .optional()
          .describe("NS hostnames with trailing dots."),
        masters: z
          .array(z.string())
          .max(10)
          .optional()
          .describe("Primary IPs (Secondary zones only)."),
        responsible_email: z.string().optional().describe("SOA RNAME as an email address."),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    tool(async ({ name, server_slug, kind, nameservers, masters, responsible_email }) => {
      const selected = await resolveServer(server_slug);
      const result = await dispatchCreateZone(request, {
        serverSlug: selected.slug,
        name: canonicalZone(name),
        kind,
        ...(nameservers ? { nameservers } : {}),
        ...(masters ? { masters } : {}),
        ...(responsible_email ? { responsibleEmail: responsible_email } : {}),
      });
      return text({ ok: true, server: selected.slug, result });
    }),
  );

  server.registerTool(
    "delete_zone",
    {
      title: "Delete zone",
      description:
        "Delete a zone and every record in it. Irreversible. `confirm` must repeat the zone name exactly.",
      inputSchema: {
        zone: zoneArg,
        server_slug: serverArg,
        confirm: z.string().describe("Type the zone name again."),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug, confirm }) => {
      const zone = canonicalZone(zoneInput);
      if (canonicalZone(confirm) !== zone) {
        throw new ValidationError("`confirm` must repeat the zone name exactly.");
      }
      const selected = await resolveServer(server_slug);
      const result = await dispatchDeleteZone(request, { zone, serverSlug: selected.slug });
      return text({ ok: true, zone, server: selected.slug, result });
    }),
  );

  return server;
}
