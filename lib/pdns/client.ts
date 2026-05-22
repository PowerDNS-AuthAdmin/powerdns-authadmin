/**
 * lib/pdns/client.ts
 *
 * Typed entry point for the PowerDNS Authoritative HTTP API. One instance
 * per upstream backend; cached in memory by `lib/pdns/registry.ts` so the
 * version-cache lookup happens once per server, not per request.
 *
 * Covers: server info + cached version/capabilities; zones (list/get/create/
 * update/delete); rrsets; cryptokeys (DNSSEC); metadata; TSIG keys (with
 * one-time secret reveal); and autoprimaries — reads and mutations for each,
 * all sections of this one module.
 *
 * The client is intentionally not aware of:
 *   - The DB (we don't persist anything here; the caller decides when to
 *     write back the version cache via `lib/db/repositories/pdns-servers`).
 *   - RBAC or audit (enforced one layer up). ESLint enforces this — the
 *     import-boundary rules ban `lib/pdns/*` from importing `lib/rbac/*`,
 *     `lib/audit/*`, `lib/db/*`, or `lib/auth/*`.
 */

import "server-only";
import { pdnsRequest, type PdnsHttpConfig, type PdnsRequestInit } from "./http";
import {
  pdnsAutoprimaryListSchema,
  pdnsCryptokeyDetailSchema,
  pdnsCryptokeyListSchema,
  pdnsMetadataListSchema,
  pdnsMetadataSchema,
  pdnsServerInfoSchema,
  pdnsStatisticsSchema,
  type PdnsStatisticsEntry,
  pdnsTsigKeyDetailSchema,
  pdnsTsigKeyListSchema,
  pdnsZoneDetailSchema,
  pdnsZoneListSchema,
  type PdnsAutoprimary,
  type PdnsCryptokeyDetail,
  type PdnsCryptokeySummary,
  type PdnsMetadata,
  type PdnsServerInfo,
  type PdnsTsigKeyDetail,
  type PdnsTsigKeySummary,
  type PdnsVersionCache,
  type PdnsZoneDetail,
  type PdnsZoneSummary,
} from "./types";
import { buildVersionCache, isVersionCacheFresh } from "./version";
import type { ZoneRRsetPatchBody } from "./rrsets";

const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface PdnsClientConfig extends PdnsHttpConfig {
  /** PDNS server-id (path segment after `/servers/`), e.g. "localhost". */
  serverId: string;
  /** Last persisted version snapshot; reused until {@link VERSION_CACHE_TTL_MS} elapses. */
  initialVersionCache?: PdnsVersionCache | null;
}

/**
 * Stateful client for a single PDNS backend. Construct via
 * `createPdnsClient(config)` rather than `new` so the cached state is on the
 * returned instance, not the (immutable) config.
 */
export class PdnsClient {
  public readonly serverSlug: string;
  public readonly serverId: string;

  private readonly httpConfig: PdnsHttpConfig;
  private versionCache: PdnsVersionCache | null;

  public constructor(config: PdnsClientConfig) {
    this.serverSlug = config.serverSlug;
    this.serverId = config.serverId;
    this.httpConfig = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      serverSlug: config.serverSlug,
      ...(config.serverDbId !== undefined ? { serverDbId: config.serverDbId } : {}),
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    };
    this.versionCache = config.initialVersionCache ?? null;
  }

  // ---------------------------------------------------------------------------
  // server
  // ---------------------------------------------------------------------------

  /** Raw `GET /servers/{id}`. Validated against the type schema. */
  public async serverInfo(): Promise<PdnsServerInfo> {
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}`,
      op: "server.info",
    });
    return pdnsServerInfoSchema.parse(body);
  }

  /**
   * `GET /servers/{id}/statistics` — 100+ counters/maps/rings. Used
   * by the background sampler. Caller filters down to the metrics we
   * actually graph; the schema preserves the discriminated-union
   * shape so callers can switch on `type`.
   */
  public async statistics(): Promise<PdnsStatisticsEntry[]> {
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/statistics`,
      op: "server.statistics",
    });
    return pdnsStatisticsSchema.parse(body);
  }

  /**
   * Cached capability snapshot. Refreshes when the cache is older than
   * `VERSION_CACHE_TTL_MS`. Returns both the snapshot and a `refreshed` flag
   * so the caller can decide whether to persist it back to the row.
   */
  public async version(): Promise<{
    cache: PdnsVersionCache;
    refreshed: boolean;
  }> {
    if (isVersionCacheFresh(this.versionCache, VERSION_CACHE_TTL_MS)) {
      return { cache: this.versionCache, refreshed: false };
    }
    const info = await this.serverInfo();
    const cache = buildVersionCache(info.version, this.serverId);
    this.versionCache = cache;
    return { cache, refreshed: true };
  }

  /** True if the cached capability is present and indicates support. */
  public supports(capability: keyof PdnsVersionCache["capabilities"]): boolean {
    return this.versionCache?.capabilities[capability] === true;
  }

  // ---------------------------------------------------------------------------
  // zones
  // ---------------------------------------------------------------------------

  /** `GET /servers/{id}/zones` — returns the zone summary list. */
  public async listZones(): Promise<PdnsZoneSummary[]> {
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/zones`,
      op: "zones.list",
    });
    return pdnsZoneListSchema.parse(body);
  }

  /** `GET /servers/{id}/zones/{zoneId}` — detail incl. `rrsets`. */
  public async getZone(zoneName: string): Promise<PdnsZoneDetail> {
    const id = normalizeZoneId(zoneName);
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}`,
      op: "zones.get",
    });
    return pdnsZoneDetailSchema.parse(body);
  }

  /**
   * `POST /servers/{id}/zones` — create a new zone.
   *
   * Body shape per the PDNS HTTP API: at minimum `name` (with trailing
   * dot), `kind`. Optional `nameservers` (only honored by PDNS when the
   * NS records aren't already inside `rrsets`), `masters`/`primaries` for
   * Slave/Secondary zones, and `rrsets` to pre-populate. PDNS returns the
   * created zone's full detail; we re-parse it through the same schema
   * `getZone` uses so the caller gets a typed result.
   *
   * The `nameservers` and `rrsets` fields are mutually exclusive in PDNS —
   * if `rrsets` contains NS records, omit `nameservers`. The caller decides
   * which form to send.
   */
  public async createZone(input: {
    name: string;
    kind: "Native" | "Master" | "Slave" | "Primary" | "Secondary" | "Producer" | "Consumer";
    nameservers?: string[];
    masters?: string[];
    rrsets?: ZoneRRsetPatchBody["rrsets"];
    dnssec?: boolean;
  }): Promise<PdnsZoneDetail> {
    const body: Record<string, unknown> = {
      name: normalizeZoneId(input.name),
      kind: normalizeZoneKindForWire(input.kind),
    };
    if (input.nameservers && input.nameservers.length > 0) {
      body["nameservers"] = input.nameservers;
    }
    if (input.masters && input.masters.length > 0) {
      body["masters"] = input.masters;
    }
    if (input.rrsets && input.rrsets.length > 0) {
      body["rrsets"] = input.rrsets;
    }
    if (input.dnssec) {
      body["dnssec"] = true;
    }

    const raw = await this.request<unknown>({
      method: "POST",
      path: `/servers/${this.serverId}/zones`,
      op: "zones.create",
      body,
    });
    return pdnsZoneDetailSchema.parse(raw);
  }

  /**
   * `PATCH /servers/{id}/zones/{zoneId}` — apply one or more RRset patches.
   * Build the body with the helpers in `lib/pdns/rrsets`. PDNS returns 204
   * on success; on conflict / validation failure the typed PdnsError
   * subclasses bubble.
   *
   * Capability gate: before sending EXTEND/PRUNE changetypes, check
   * `client.supports("supportsExtendPrune")` and fall back to REPLACE if
   * unsupported. The caller owns that decision — the client transmits what
   * it's given.
   */
  public async patchZone(zoneName: string, body: ZoneRRsetPatchBody): Promise<void> {
    const id = normalizeZoneId(zoneName);
    await this.request<void>({
      method: "PATCH",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}`,
      op: "zones.patch",
      body,
    });
  }

  /**
   * `PUT /servers/{id}/zones/{zoneId}` — modify zone-object fields.
   *
   * PDNS treats SOA-EDIT, SOA-EDIT-API, and API-RECTIFY as zone-object
   * fields (lines 806–814 of ws-auth.cc on 4.9.x), reaching past the
   * `/metadata/{kind}` allowlist and writing directly into the backend's
   * metadata storage. `kind` is also settable here to flip between
   * Native/Primary/Secondary, with optional `masters` for Secondary.
   *
   * Pass only the fields the operator changed — PDNS ignores absent
   * fields rather than blanking them out.
   */
  public async updateZoneSettings(
    zoneName: string,
    settings: {
      kind?: "Native" | "Master" | "Slave" | "Primary" | "Secondary" | "Producer" | "Consumer";
      masters?: readonly string[];
      soa_edit?: string;
      soa_edit_api?: string;
      api_rectify?: boolean;
    },
  ): Promise<void> {
    // PDNS Authoritative still requires Master/Slave for the wire `kind`
    // value (the API hasn't caught up with pdnsutil + config which now use
    // Primary/Secondary). Normalize before sending so callers passing the
    // modern terminology don't get a "400 invalid kind" from PDNS.
    if (settings.kind !== undefined) {
      settings = { ...settings, kind: normalizeZoneKindForWire(settings.kind) };
    }
    const id = normalizeZoneId(zoneName);
    await this.request<void>({
      method: "PUT",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}`,
      op: "zones.settings.update",
      body: settings,
    });
  }

  /**
   * `DELETE /servers/{id}/zones/{zoneId}` — drop the zone entirely.
   *
   * PDNS returns 204 on success. We don't try to back the zone up
   * upstream — backup is the caller's responsibility (the web UI
   * forces a BIND export before exposing the delete button).
   */
  public async deleteZone(zoneName: string): Promise<void> {
    const id = normalizeZoneId(zoneName);
    await this.request<void>({
      method: "DELETE",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}`,
      op: "zones.delete",
    });
  }

  /**
   * `PUT /servers/{id}/zones/{zoneId}/notify` — ask PDNS to send NOTIFY
   * packets to every secondary listed in the zone's NS records plus any
   * ALSO-NOTIFY metadata. Only meaningful for Master/Primary zones; PDNS
   * 422s on Native / Slave / Consumer zones, which we let the typed error
   * surface so callers can decide whether the failure is interesting.
   *
   * NOTIFY is fire-and-forget from PDNS' perspective — the response just
   * confirms PDNS queued the notifications, not that any secondary acked.
   */
  public async notifyZone(zoneName: string): Promise<void> {
    const id = normalizeZoneId(zoneName);
    await this.request<void>({
      method: "PUT",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/notify`,
      op: "zones.notify",
    });
  }

  // ---------------------------------------------------------------------------
  // cryptokeys (DNSSEC) — list/get + create/update/delete.
  // ---------------------------------------------------------------------------

  /**
   * `GET /servers/{id}/zones/{zoneId}/cryptokeys` — list every cryptokey
   * configured for the zone. Returns the array (possibly empty when the
   * zone has DNSSEC disabled). `privatekey` is never present in this
   * response shape — PDNS omits it from the list endpoint regardless of
   * query parameters.
   */
  public async listCryptokeys(zoneName: string): Promise<PdnsCryptokeySummary[]> {
    const id = normalizeZoneId(zoneName);
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/cryptokeys`,
      op: "cryptokeys.list",
    });
    return pdnsCryptokeyListSchema.parse(body);
  }

  /**
   * `GET /servers/{id}/zones/{zoneId}/cryptokeys/{cryptokey_id}` — detail
   * for a single key. We deliberately do NOT request `?includeprivate=true`
   * here; that would surface the unwrapped private key material in the
   * response body and we don't yet have a storage path designed for it.
   * Adding that requires extending the at-rest encryption envelope and a
   * dedicated reveal flow (see S-8's `temp-reveal-store` pattern).
   */
  public async getCryptokey(zoneName: string, cryptokeyId: number): Promise<PdnsCryptokeyDetail> {
    const id = normalizeZoneId(zoneName);
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/cryptokeys/${cryptokeyId}`,
      op: "cryptokeys.get",
    });
    return pdnsCryptokeyDetailSchema.parse(body);
  }

  /**
   * `POST /servers/{id}/zones/{zoneId}/cryptokeys` — generate a new key
   * (PDNS does the cryptographic work) and return the resulting record.
   *
   * Defaults align with what an operator usually wants:
   *   - `keytype: "ksk"` if not specified (KSKs are the primary thing
   *     operators rotate manually; ZSKs are typically auto-rolled).
   *   - `active: true` so the new key starts signing immediately. Set
   *     `false` when staging a rollover and you want to publish without
   *     signing yet.
   *   - `algorithm` and `bits` fall through to PDNS' configured
   *     defaults (typically ECDSAP256SHA256 in 4.5+).
   *
   * **Key material handling**: we explicitly do NOT pass `privatekey`
   * (no import-existing-key) nor query `?includeprivate=true` (no
   * server-generated key export). Either path would mean handling raw
   * private keys, which needs the encryption envelope + a reveal flow
   * we haven't designed. PDNS keeps the key in its own store; we never
   * see it.
   */
  public async createCryptokey(
    zoneName: string,
    input: {
      keytype?: "ksk" | "zsk" | "csk";
      active?: boolean;
      published?: boolean;
      algorithm?: string;
      bits?: number;
    } = {},
  ): Promise<PdnsCryptokeyDetail> {
    const id = normalizeZoneId(zoneName);
    const body: Record<string, unknown> = {
      keytype: input.keytype ?? "ksk",
      active: input.active ?? true,
    };
    if (input.published !== undefined) body["published"] = input.published;
    if (input.algorithm !== undefined) body["algorithm"] = input.algorithm;
    if (input.bits !== undefined) body["bits"] = input.bits;

    const raw = await this.request<unknown>({
      method: "POST",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/cryptokeys`,
      op: "cryptokeys.create",
      body,
    });
    return pdnsCryptokeyDetailSchema.parse(raw);
  }

  /**
   * `PUT /servers/{id}/zones/{zoneId}/cryptokeys/{cryptokey_id}` —
   * toggle `active` and/or `published`. The two flags are independent:
   *   - `active=false, published=true` → key is in the zone but not
   *     signing (the "pre-publish" half of a rollover).
   *   - `active=true, published=false` → key is signing but not visible
   *     in DNSKEY (the "double-signature" half).
   * Operators usually only flip `active`; the `published` flag is for
   * rollover orchestration.
   *
   * Returns void — PDNS sends 204 No Content. Call `getCryptokey` after
   * if the caller needs the updated detail.
   */
  public async updateCryptokey(
    zoneName: string,
    cryptokeyId: number,
    patch: { active?: boolean; published?: boolean },
  ): Promise<void> {
    if (patch.active === undefined && patch.published === undefined) {
      // PDNS happily accepts an empty body and no-ops, but the call is
      // wasted work — surface the bug at the boundary.
      throw new Error("updateCryptokey requires at least one of active/published.");
    }
    const id = normalizeZoneId(zoneName);
    await this.request<void>({
      method: "PUT",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/cryptokeys/${cryptokeyId}`,
      op: "cryptokeys.update",
      body: patch,
    });
  }

  /**
   * `DELETE /servers/{id}/zones/{zoneId}/cryptokeys/{cryptokey_id}` —
   * permanent. The deleted key is gone from PDNS' store; if it was the
   * only KSK, the zone is now unsigned until another KSK is created
   * and the parent's DS records are updated. PDNS does not refuse the
   * delete in that case — the caller decides whether the operation is
   * safe (e.g., the admin UI should confirm + warn).
   */
  public async deleteCryptokey(zoneName: string, cryptokeyId: number): Promise<void> {
    const id = normalizeZoneId(zoneName);
    await this.request<void>({
      method: "DELETE",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/cryptokeys/${cryptokeyId}`,
      op: "cryptokeys.delete",
    });
  }

  // ---------------------------------------------------------------------------
  // metadata — list/get + set/delete.
  // ---------------------------------------------------------------------------

  /**
   * `GET /servers/{id}/zones/{zoneId}/metadata` — list every metadata
   * entry for the zone. The list may be empty when no metadata has
   * ever been set (common for fresh zones).
   *
   * PDNS returns every kind as its own item, with `metadata: string[]`
   * for the value (even when conceptually a single value). The schema
   * preserves that shape so the UI can render multi-line values like
   * ALSO-NOTIFY (one IP per array slot) without special-casing.
   */
  public async listZoneMetadata(zoneName: string): Promise<PdnsMetadata[]> {
    const id = normalizeZoneId(zoneName);
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/metadata`,
      op: "zone.metadata.list",
    });
    return pdnsMetadataListSchema.parse(body);
  }

  /**
   * `GET /servers/{id}/zones/{zoneId}/metadata/{kind}` — read one kind.
   * Returns null when the kind has never been set on this zone (PDNS
   * 404s; we translate to null so the UI can render "not set"
   * uniformly with empty-array results from a kind that was set to
   * empty).
   *
   * `kind` is sent as the path segment. PDNS expects the canonical
   * uppercase-hyphen form (`ALLOW-AXFR-FROM`, not `allow-axfr-from`);
   * we pass it through verbatim so the caller controls the shape.
   */
  public async getZoneMetadata(zoneName: string, kind: string): Promise<PdnsMetadata | null> {
    const id = normalizeZoneId(zoneName);
    try {
      const body = await this.request<unknown>({
        method: "GET",
        path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/metadata/${encodeURIComponent(kind)}`,
        op: "zone.metadata.get",
      });
      return pdnsMetadataSchema.parse(body);
    } catch (err) {
      // Some PDNS builds return 422 "Unsupported metadata kind 'X'" on
      // GET for kinds they don't surface individually (the LIST endpoint
      // still includes the row). Treat that the same as 404 — caller
      // falls back to the list-derived value.
      const { PdnsNotFoundError, PdnsUnprocessableError } = await import("./errors");
      if (err instanceof PdnsNotFoundError) return null;
      if (err instanceof PdnsUnprocessableError) return null;
      throw err;
    }
  }

  /**
   * `PUT /servers/{id}/zones/{zoneId}/metadata/{kind}` — replace all
   * values for `kind` with `values`. Upsert semantics: creates the kind
   * if it didn't exist, replaces if it did. PDNS returns the resulting
   * record; we parse and return it so the caller gets the
   * server-canonicalized shape (PDNS may normalize whitespace or case
   * on some kinds).
   *
   * Passing an empty `values` array creates a "set but empty" entry
   * which renders as `(kind set but empty)` in the UI. Callers that
   * want the kind removed entirely should call `deleteZoneMetadata`.
   */
  public async setZoneMetadata(
    zoneName: string,
    kind: string,
    values: readonly string[],
  ): Promise<PdnsMetadata> {
    const id = normalizeZoneId(zoneName);
    const raw = await this.request<unknown>({
      method: "PUT",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/metadata/${encodeURIComponent(kind)}`,
      op: "zone.metadata.set",
      body: { metadata: values },
    });
    return pdnsMetadataSchema.parse(raw);
  }

  /**
   * `DELETE /servers/{id}/zones/{zoneId}/metadata/{kind}` — remove the
   * kind entirely. PDNS sends 204. Idempotent in PDNS' semantics — a
   * second delete of a now-missing kind succeeds with the same status.
   */
  public async deleteZoneMetadata(zoneName: string, kind: string): Promise<void> {
    const id = normalizeZoneId(zoneName);
    await this.request<void>({
      method: "DELETE",
      path: `/servers/${this.serverId}/zones/${encodeURIComponent(id)}/metadata/${encodeURIComponent(kind)}`,
      op: "zone.metadata.delete",
    });
  }

  // ---------------------------------------------------------------------------
  // TSIG keys — list/get + create/delete + one-time secret reveal.
  // ---------------------------------------------------------------------------

  /**
   * `GET /servers/{id}/tsigkeys` — list every TSIG key configured on
   * this PDNS backend. PDNS does NOT include the secret material in
   * the list response — only id, name, and algorithm — which is
   * exactly the shape needed to render an inventory view.
   *
   * The summary schema deliberately does not have a `key` field, so
   * a future PDNS that *did* start returning it on the list endpoint
   * would have the extra field silently dropped by zod's default
   * pass-through behavior. The detail endpoint is the only path that
   * surfaces the secret.
   */
  public async listTsigKeys(): Promise<PdnsTsigKeySummary[]> {
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/tsigkeys`,
      op: "tsigkeys.list",
    });
    return pdnsTsigKeyListSchema.parse(body);
  }

  /**
   * `GET /servers/{id}/tsigkeys/{key_id}` — detail incl. `key` (the
   * base64-encoded shared secret). Reserved for the secret-reveal
   * admin flow — gate the call on `tsig.manage` rather than
   * `tsig.read`. Pass the returned object into `appendAudit` snapshots
   * only via the redactor (the field name `key` is in REDACT_FIELDS
   * so it auto-redacts).
   *
   * NEVER pass the full returned object to a logger — write a
   * destructured copy with `key` stripped explicitly.
   */
  public async getTsigKey(keyId: string): Promise<PdnsTsigKeyDetail> {
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/tsigkeys/${encodeURIComponent(keyId)}`,
      op: "tsigkeys.get",
    });
    return pdnsTsigKeyDetailSchema.parse(body);
  }

  /**
   * `POST /servers/{id}/tsigkeys` — generate a new TSIG key. PDNS does
   * the HMAC key generation server-side; we never pass an
   * operator-supplied `key` so the secret only exists in PDNS and (via
   * the temp-reveal-store) in the operator's browser session that
   * issued the create. This mirrors the DNSSEC `createCryptokey`
   * discipline.
   *
   * The response includes `key` — the freshly generated base64 HMAC
   * secret. Callers are responsible for:
   *   1. Stashing it in the temp-reveal-store (one-shot, actor-bound),
   *   2. Stripping `key` from any audit snapshot (the audit redactor
   *      catches `key` automatically, but don't rely on that — destructure
   *      explicitly when shaping the audit payload).
   *
   * Algorithm defaults to `hmac-sha256` — PDNS' modern default and
   * what every BIND/Knot secondary supports out of the box.
   */
  public async createTsigKey(input: {
    name: string;
    algorithm?: string;
  }): Promise<PdnsTsigKeyDetail> {
    const body = await this.request<unknown>({
      method: "POST",
      path: `/servers/${this.serverId}/tsigkeys`,
      op: "tsigkeys.create",
      body: {
        name: input.name,
        algorithm: input.algorithm ?? "hmac-sha256",
      },
    });
    return pdnsTsigKeyDetailSchema.parse(body);
  }

  /**
   * `DELETE /servers/{id}/tsigkeys/{key_id}` — permanent. Once gone,
   * any zone metadata that references this key by name (TSIG-ALLOW-AXFR,
   * AXFR-MASTER-TSIG) starts rejecting transfers. The caller (admin UI)
   * is responsible for warning operators about that ripple effect.
   */
  public async deleteTsigKey(keyId: string): Promise<void> {
    await this.request<void>({
      method: "DELETE",
      path: `/servers/${this.serverId}/tsigkeys/${encodeURIComponent(keyId)}`,
      op: "tsigkeys.delete",
    });
  }

  // ---------------------------------------------------------------------------
  // autoprimaries — full CRUD; no secret material involved.
  // ---------------------------------------------------------------------------

  /**
   * `GET /servers/{id}/autoprimaries` — list the trusted primaries this
   * server will auto-create slave zones from. Returns the array (which
   * may be empty when autoprimary handling is disabled or simply
   * unconfigured).
   */
  public async listAutoprimaries(): Promise<PdnsAutoprimary[]> {
    const body = await this.request<unknown>({
      method: "GET",
      path: `/servers/${this.serverId}/autoprimaries`,
      op: "autoprimaries.list",
    });
    return pdnsAutoprimaryListSchema.parse(body);
  }

  /**
   * `POST /servers/{id}/autoprimaries` — register a (ip, nameserver,
   * account?) tuple. PDNS rejects duplicates with 409. Returns 201
   * with no body; callers should refresh via `listAutoprimaries` if
   * they need the canonical list back.
   */
  public async createAutoprimary(input: PdnsAutoprimary): Promise<void> {
    await this.request<void>({
      method: "POST",
      path: `/servers/${this.serverId}/autoprimaries`,
      op: "autoprimaries.create",
      body: input,
    });
  }

  /**
   * `DELETE /servers/{id}/autoprimaries/{ip}/{nameserver}` — remove a
   * registered primary by its compound key. PDNS treats the pair
   * (ip, nameserver) as the row identifier; `account` is informational
   * and doesn't participate in lookup or delete.
   */
  public async deleteAutoprimary(input: { ip: string; nameserver: string }): Promise<void> {
    await this.request<void>({
      method: "DELETE",
      path: `/servers/${this.serverId}/autoprimaries/${encodeURIComponent(input.ip)}/${encodeURIComponent(input.nameserver)}`,
      op: "autoprimaries.delete",
    });
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private request<T>(init: PdnsRequestInit): Promise<T> {
    return pdnsRequest<T>(this.httpConfig, init);
  }
}

/**
 * Canonicalize a user-provided zone identifier. PDNS treats the zone id as
 * the FQDN with a trailing dot; we trim whitespace, lowercase, and append
 * the dot if it's missing.
 */
export function normalizeZoneId(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "") return trimmed;
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

/**
 * Coerce the zone `kind` value to what the PDNS Authoritative API accepts
 * on the wire. PDNS' config settings + pdnsutil moved to Primary/Secondary,
 * but `POST /zones { kind }` and `PUT /zones/{id} { kind }` still require
 * the legacy Master/Slave strings (the API hasn't caught up).
 *
 * Native, Producer, and Consumer pass through unchanged. Anything else is
 * treated as Master so a stray value can't silently become a no-op.
 */
export function normalizeZoneKindForWire(
  kind: "Native" | "Master" | "Slave" | "Primary" | "Secondary" | "Producer" | "Consumer",
): "Native" | "Master" | "Slave" | "Producer" | "Consumer" {
  if (kind === "Primary") return "Master";
  if (kind === "Secondary") return "Slave";
  return kind;
}
