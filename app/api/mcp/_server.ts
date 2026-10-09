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
import { canonicalName, canonicalZone, filterRows, flattenRrsets } from "./_records";

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
- Every write is authorised against the token's permissions and recorded in the audit log under the token owner's name. Prefer list_records before changing anything so you replace exactly what you intend.`;

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
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug, name, type, records, ttl, comment }) => {
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
        result,
      });
    }),
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
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug, name, type, content, ttl }) => {
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
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ zone: zoneInput, server_slug, name, type, content }) => {
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
        result,
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
