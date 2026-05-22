/**
 * app/api/admin/pdns/zones/route.ts
 *
 * POST — create a zone on a PDNS backend, optionally seeded from a zone
 *        template. Permission: `zone.create`. CSRF-guarded + audited.
 *
 * The route is the single place that:
 *   1. Builds the canonical zone name (trailing dot, lowercase).
 *   2. Resolves the template (if any) into the initial NS + SOA + prelude
 *      records.
 *   3. Lets the operator override NS / masters at creation time.
 *   4. Calls `pdnsClient.createZone()` with the resolved payload.
 *
 * The new zone's records (including SOA) are owned by PDNS once created —
 * the SOA panel and record editor take over from there.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { findClusterBySlug, listActivePeersForCluster } from "@/lib/db/repositories/pdns-clusters";
import { findZoneTemplateById } from "@/lib/db/repositories/zone-templates";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { choosePeer } from "@/lib/pdns/cluster-picker";
import { expandTemplateName } from "@/lib/validators/zone-templates";
import { serializeSoaContent } from "@/lib/validators/soa";
import { PdnsError } from "@/lib/pdns/errors";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const KIND_VALUES = ["Native", "Master", "Primary", "Slave", "Secondary"] as const;

const hostnameLite = z
  .string()
  .min(1)
  .max(254)
  .regex(
    /^[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?(?:\.[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?)*\.?$/,
    "Hostname looks malformed.",
  );

const ipLite = z
  .string()
  .min(1)
  .max(45)
  .regex(/^[0-9a-fA-F:.]+$/, "Master must be an IPv4 or IPv6 address.");

const createZoneSchema = z.object({
  /** Concrete server slug — for standalone primaries OR primary+secondaries. */
  serverSlug: z.string().optional(),
  /** Cluster slug — the write_strategy picks the peer at apply time. */
  clusterSlug: z.string().optional(),
  /** Zone name, with or without trailing dot. */
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(
      /^[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?(?:\.[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?)*\.?$/,
      "Zone name has invalid label characters.",
    ),
  kind: z.enum(KIND_VALUES),
  /** Operator-supplied NS list. If empty AND a template is selected, the
   *  template's `nameservers` field is used. */
  nameservers: z.array(hostnameLite).max(13).default([]),
  /** Primary master IPs — required for Slave/Secondary, ignored otherwise. */
  masters: z.array(ipLite).max(10).default([]),
  templateId: z.string().uuid().optional(),
  /** Email for the SOA responsible mailbox; defaults to hostmaster@<zone>. */
  responsibleEmail: z
    .string()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Looks like it isn't a valid email.")
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "zone.create" });
    await requireCsrf(request);

    let input;
    try {
      input = createZoneSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    // ── Backend resolution ─────────────────────────────────────────────────
    // Cluster targets resolve to a peer via the cluster's write_strategy;
    // server targets resolve directly. Exactly one of serverSlug /
    // clusterSlug should be set — the form sends a discriminated value.
    if (input.serverSlug && input.clusterSlug) {
      throw new ValidationError(
        "Provide either serverSlug or clusterSlug, not both — they're mutually exclusive.",
      );
    }
    let server;
    if (input.clusterSlug) {
      const cluster = await findClusterBySlug(input.clusterSlug);
      if (!cluster) {
        throw new ValidationError("Unknown cluster.");
      }
      const peers = await listActivePeersForCluster(cluster.id);
      if (peers.length === 0) {
        throw new ValidationError("Cluster has no active peers — add or re-enable a peer first.");
      }
      const chosen = await choosePeer(cluster, peers);
      if (!chosen) {
        throw new ValidationError("Could not choose a write peer for the cluster.");
      }
      server = chosen;
    } else {
      server = input.serverSlug
        ? await findPdnsServerBySlug(input.serverSlug)
        : await findDefaultPdnsServer();
      if (server?.disabledAt !== null) {
        throw new ValidationError("Unknown or disabled PowerDNS backend.");
      }
    }

    // ── Canonical zone name (trailing dot, lowercase) ──────────────────────
    const lower = input.name.toLowerCase();
    const zoneName = lower.endsWith(".") ? lower : `${lower}.`;

    // ── Slave / Secondary requires master IPs ──────────────────────────────
    const isSecondary = input.kind === "Slave" || input.kind === "Secondary";
    if (isSecondary && input.masters.length === 0) {
      throw new ValidationError(
        "Secondary / Slave zones need at least one primary master IP to pull from.",
      );
    }
    if (!isSecondary && input.masters.length > 0) {
      throw new ValidationError(
        "Master / Primary / Native zones can't have a `masters` list — that field is only meaningful for Secondary.",
      );
    }

    // ── Template resolution ────────────────────────────────────────────────
    const template = input.templateId ? await findZoneTemplateById(input.templateId) : null;
    if (input.templateId && !template) {
      throw new ValidationError("Selected zone template no longer exists.");
    }

    // Effective NS list: operator-supplied overrides template, template fills
    // when operator left it blank. NS records aren't required for Secondary
    // zones (the primary pushes them in over AXFR), but we still allow them.
    const nameservers =
      input.nameservers.length > 0 ? input.nameservers : (template?.nameservers ?? []);
    const normalizedNs = nameservers.map((ns) =>
      ns.endsWith(".") ? ns.toLowerCase() : `${ns.toLowerCase()}.`,
    );

    if (!isSecondary && normalizedNs.length === 0) {
      throw new ValidationError(
        "At least one NS record is required (RFC 1035). Add one, or pick a template that defines defaults.",
      );
    }
    if (!isSecondary && normalizedNs.length < 2) {
      // RFC 2182 § 5 recommends ≥ 2. We treat one-NS as a soft warning —
      // surface it in the audit log but don't block.
      logger.warn({ zone: zoneName, nsCount: normalizedNs.length }, "zone.create.single-ns");
    }

    // ── Build the rrsets payload ───────────────────────────────────────────
    interface Record {
      content: string;
      disabled?: boolean;
    }
    interface RRsetPatch {
      name: string;
      type: string;
      ttl: number;
      changetype: "REPLACE";
      records: Record[];
    }
    const rrsetsByKey = new Map<string, RRsetPatch>();
    const upsertRRset = (name: string, type: string, ttl: number, record: Record) => {
      const key = `${name}|${type}`;
      const existing = rrsetsByKey.get(key);
      if (existing) {
        existing.records.push(record);
        existing.ttl = ttl;
      } else {
        rrsetsByKey.set(key, {
          name,
          type,
          ttl,
          changetype: "REPLACE",
          records: [record],
        });
      }
    };

    // SOA — only meaningful for non-Secondary zones (Secondary fetches it from
    // primary). PDNS will synthesize a SOA if we don't supply one for
    // Master/Native, but pre-seeding lets us honor the template's timers.
    if (!isSecondary && normalizedNs.length > 0) {
      const primaryNs = normalizedNs[0]!;
      const responsibleEmail = input.responsibleEmail ?? `hostmaster@${lower.replace(/\.$/, "")}`;
      const localPart = responsibleEmail.split("@")[0]!.replace(/\./g, "\\.");
      const domain = responsibleEmail.split("@")[1]!;
      const rname = `${localPart}.${domain.replace(/\.$/, "")}.`;
      const soa = {
        mname: primaryNs,
        rname,
        serial: nowSerial(),
        refresh: template?.soaRefresh ?? 3600,
        retry: template?.soaRetry ?? 900,
        expire: template?.soaExpire ?? 604800,
        minimum: template?.soaMinimum ?? 3600,
      };
      upsertRRset(zoneName, "SOA", template?.soaTtl ?? 3600, {
        content: serializeSoaContent(soa),
      });
    }

    // NS records at the apex.
    if (!isSecondary) {
      for (const ns of normalizedNs) {
        upsertRRset(zoneName, "NS", template?.soaTtl ?? 3600, { content: ns });
      }
    }

    // Template prelude records.
    if (template) {
      for (const r of template.records) {
        const expanded = expandTemplateName(r.name, zoneName);
        const record: Record = { content: r.content };
        if (r.disabled) record.disabled = true;
        upsertRRset(expanded, r.type.toUpperCase(), r.ttl, record);
      }
    }

    const rrsets = Array.from(rrsetsByKey.values());

    // ── Create on PDNS ─────────────────────────────────────────────────────
    const client = getPdnsClientForRow(server);
    let createdZone;
    try {
      createdZone = await client.createZone({
        name: zoneName,
        kind: input.kind,
        ...(rrsets.length > 0 ? { rrsets } : {}),
        ...(isSecondary ? { masters: input.masters } : {}),
        // If we passed rrsets containing NS, PDNS ignores `nameservers`. If
        // we didn't pre-seed NS (template-less Secondary), don't bother.
      });
    } catch (err) {
      if (err instanceof PdnsError) {
        throw new ConflictError(`PDNS: ${redact(err.message)}`);
      }
      throw err;
    }

    // Apply template's zone-object defaults (soa_edit, soa_edit_api,
    // api_rectify) via a follow-up PUT /zones/{id}. PDNS' create path
    // already accepts these fields, but PUT is the supported surface
    // and keeps the apply path uniform with subsequent edits via the
    // Zone settings tab.
    if (template) {
      const settings: Parameters<typeof client.updateZoneSettings>[1] = {};
      if (template.soaEdit) settings.soa_edit = template.soaEdit;
      if (template.soaEditApi) settings.soa_edit_api = template.soaEditApi;
      if (template.apiRectify !== null) settings.api_rectify = template.apiRectify;
      if (Object.keys(settings).length > 0) {
        try {
          await client.updateZoneSettings(zoneName, settings);
        } catch (err) {
          // Settings failure mustn't roll back the zone — the zone is
          // already created; the operator can fix settings later.
          logger.warn(
            {
              server: server.slug,
              zone: zoneName,
              error: err instanceof Error ? err.message : "unknown",
            },
            "zone.create.template-settings.failed",
          );
        }
      }
      // Apply template metadata bag via per-kind PUTs. We swallow
      // individual failures so a single unsupported kind doesn't break
      // the rest — PDNS' metadata allowlist varies across versions.
      for (const [kind, values] of Object.entries(template.metadata)) {
        try {
          await client.setZoneMetadata(zoneName, kind, values);
        } catch (err) {
          logger.warn(
            {
              server: server.slug,
              zone: zoneName,
              kind,
              error: err instanceof Error ? err.message : "unknown",
            },
            "zone.create.template-metadata.failed",
          );
        }
      }
    }

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "zone.create",
      resource: { type: "zone", id: `${server.slug}:${zoneName}` },
      after: {
        zone: zoneName,
        kind: input.kind,
        templateSlug: template?.slug ?? null,
        nameservers: normalizedNs,
        masters: isSecondary ? input.masters : [],
        rrsetCount: rrsets.length,
      },
      request: getRequestContext(hdrs),
    });

    // Auto-NOTIFY freshly-created Master/Primary zones so secondaries
    // pick up the new zone immediately instead of waiting for refresh.
    // Same best-effort pattern as the rrsets PATCH route — failures are
    // logged + audited but never fail the user's create.
    if (input.kind === "Master" || input.kind === "Primary") {
      let notified = false;
      let notifyError: string | null = null;
      try {
        await client.notifyZone(zoneName);
        notified = true;
      } catch (err) {
        notifyError = err instanceof Error ? redact(err.message) : "unknown";
        logger.warn(
          { server: server.slug, zone: zoneName, error: notifyError },
          "zones.create.notify.failed",
        );
      }
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "zone.notify",
        resource: { type: "zone", id: `${server.slug}:${zoneName}` },
        after: { kind: input.kind, success: notified, error: notifyError },
        request: getRequestContext(hdrs),
      });
    }

    // Realtime fan-out — both the zone-detail and zones-list pages
    // subscribe and refresh on this.
    publishZoneEvent({
      type: "zone.updated",
      zone: zoneName,
      serverSlug: server.slug,
      actor: user.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    return Response.json(
      {
        ok: true,
        zone: { id: createdZone.id, name: createdZone.name },
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "zones.create.route.error");
  }
}

/** Build a SOA serial in YYYYMMDDnn form (RFC 1912 § 2.2 convention). */
function nowSerial(): number {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return Number(`${y}${m}${day}01`);
}
