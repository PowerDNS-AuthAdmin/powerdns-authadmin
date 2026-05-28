/**
 * lib/provisioning/apply.ts
 *
 * Applies a parsed `ProvisioningConfig` to the database. Each section is
 * applied in order; the order matters because later sections reference
 * earlier ones by slug:
 *
 *   1. settings        (no FKs to anything)
 *   2. roles           (referenced by oidc.group_mappings and teams)
 *   3. teams           (referenced by oidc.group_mappings scope=team:<slug>)
 *   4. zone_templates  (no FKs to anything we provision)
 *   5. pdns_servers    — primaries first, then secondaries (which reference
 *                        primaries by slug → looked up post-insert)
 *   6. oidc            (group_mappings hold slugs that resolve to roles/
 *                        teams/servers above; zone scope is a literal name)
 *
 * Idempotency: every entry is upserted on its slug (or KV key for
 * settings). Re-applying the same file is a no-op aside from updated_at
 * bumps. Sections the operator omitted are not touched.
 *
 * Audit: a single `provisioning.applied` row is written at the end with a
 * summary of what changed. Individual upserts are NOT audited — the file
 * itself is the source of truth, and the row count would be noisy.
 */

import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  authProviderSlugs,
  ldapProviders,
  oidcProviders,
  pdnsClusters,
  pdnsServers,
  roles,
  samlProviders,
  settings,
  teams,
  zoneTemplates,
  type LdapGroupMapping,
  type OidcGroupMapping,
  type SamlGroupMapping,
  type TemplateRecord,
} from "@/lib/db/schema";
import { lookupProviderTypeBySlug } from "@/lib/db/repositories/auth-provider-slugs";
import { encrypt } from "@/lib/crypto/encryption";
import { logger } from "@/lib/logger";
import { appendAudit } from "@/lib/audit/log";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { refreshAllBackendsHealth } from "@/lib/realtime/backend-health";
import { sampleAllOidcDiscoveryNow } from "@/lib/auth/providers/oidc-discovery-sampler";
import { createZoneAndNotify, notifyEveryZoneBestEffort } from "@/lib/pdns/operations";
import { choosePeer } from "@/lib/pdns/cluster-picker";
import { listActivePeersForCluster, findClusterBySlug } from "@/lib/db/repositories/pdns-clusters";
import { findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import type { PdnsServer } from "@/lib/db/schema";
import { generateZones } from "./zone-generator";
import type { ProvisioningConfig } from "./schema";
import { parseScopeString } from "./schema";

export interface ProvisioningResult {
  settingsWritten: number;
  rolesUpserted: number;
  teamsUpserted: number;
  zoneTemplatesUpserted: number;
  pdnsClustersUpserted: number;
  pdnsServersUpserted: number;
  /** Demo zones created on PDNS during this run. Existing zones (re-runs)
   *  count toward `demoZonesSkipped` instead. */
  demoZonesCreated: number;
  demoZonesSkipped: number;
  demoZonesFailed: number;
  oidcProvidersUpserted: number;
  samlProvidersUpserted: number;
  ldapProvidersUpserted: number;
  /** Unresolvable scope references in group mappings (logged + audited; the
   *  rest of the mapping list is still persisted, with the bad entries
   *  filtered out). Covers both OIDC and LDAP mappings — the shape is
   *  identical. */
  unresolvedGroupMappings: Array<{ provider: string; group: string; scope: string }>;
}

/**
 * Apply the parsed config. Writes one `provisioning.applied` audit row at
 * the end. Throws on any unexpected DB error; callers should treat the
 * provisioning step as fatal (the boot path does).
 */
export async function applyProvisioning(config: ProvisioningConfig): Promise<ProvisioningResult> {
  const result: ProvisioningResult = {
    settingsWritten: 0,
    rolesUpserted: 0,
    teamsUpserted: 0,
    zoneTemplatesUpserted: 0,
    pdnsClustersUpserted: 0,
    pdnsServersUpserted: 0,
    demoZonesCreated: 0,
    demoZonesSkipped: 0,
    demoZonesFailed: 0,
    oidcProvidersUpserted: 0,
    samlProvidersUpserted: 0,
    ldapProvidersUpserted: 0,
    unresolvedGroupMappings: [],
  };

  // 1. settings
  //
  // `auth_default_provider` is special-cased: deferred to step 7 (after the
  // OIDC section) so a bare-slug value can be resolved against providers
  // declared in the SAME provisioning file. Writing it now would fail the
  // lookup if the slug only appears later in the YAML.
  if (config.settings) {
    for (const [key, value] of Object.entries(config.settings)) {
      if (value === undefined) continue;
      if (key === "auth_default_provider") continue; // deferred — see step 7
      await db
        .insert(settings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        });
      result.settingsWritten += 1;
    }
  }

  // 2. roles
  if (config.roles) {
    for (const r of config.roles) {
      await db
        .insert(roles)
        .values({
          slug: r.slug,
          name: r.name,
          description: r.description ?? null,
          isSystem: false,
          requiresMfa: r.requires_mfa,
          permissions: r.permissions,
        })
        .onConflictDoUpdate({
          target: roles.slug,
          set: {
            name: r.name,
            description: r.description ?? null,
            requiresMfa: r.requires_mfa,
            permissions: r.permissions,
            updatedAt: new Date(),
          },
        });
      result.rolesUpserted += 1;
    }
  }

  // 3. teams
  if (config.teams) {
    for (const t of config.teams) {
      await db
        .insert(teams)
        .values({
          slug: t.slug,
          name: t.name,
          description: t.description ?? null,
          contact: t.contact ?? null,
          mail: t.mail ?? null,
        })
        .onConflictDoUpdate({
          target: teams.slug,
          set: {
            name: t.name,
            description: t.description ?? null,
            contact: t.contact ?? null,
            mail: t.mail ?? null,
            updatedAt: new Date(),
          },
        });
      result.teamsUpserted += 1;
    }
  }

  // 4. zone_templates
  if (config.zone_templates) {
    for (const z of config.zone_templates) {
      const records: TemplateRecord[] = z.records.map((r) => ({
        name: r.name,
        type: r.type,
        ttl: r.ttl,
        content: r.content,
        disabled: r.disabled,
      }));
      await db
        .insert(zoneTemplates)
        .values({
          slug: z.slug,
          name: z.name,
          description: z.description ?? null,
          soaTtl: z.soa_ttl,
          soaRefresh: z.soa_refresh,
          soaRetry: z.soa_retry,
          soaExpire: z.soa_expire,
          soaMinimum: z.soa_minimum,
          nameservers: z.nameservers,
          records,
          kind: z.kind,
          soaEdit: z.soa_edit ?? null,
          soaEditApi: z.soa_edit_api ?? null,
          apiRectify: z.api_rectify ?? null,
          metadata: z.metadata,
          // The slug list resolves to ids only when those primaries exist;
          // we'll backfill in the pdns_servers section. For now stash the
          // raw slug list so a re-provision after primaries get inserted
          // doesn't lose them.
          defaultForPrimaryIds: z.default_for_primary_slugs,
        })
        .onConflictDoUpdate({
          target: zoneTemplates.slug,
          set: {
            name: z.name,
            description: z.description ?? null,
            soaTtl: z.soa_ttl,
            soaRefresh: z.soa_refresh,
            soaRetry: z.soa_retry,
            soaExpire: z.soa_expire,
            soaMinimum: z.soa_minimum,
            nameservers: z.nameservers,
            records,
            kind: z.kind,
            soaEdit: z.soa_edit ?? null,
            soaEditApi: z.soa_edit_api ?? null,
            apiRectify: z.api_rectify ?? null,
            metadata: z.metadata,
            defaultForPrimaryIds: z.default_for_primary_slugs,
            updatedAt: new Date(),
          },
        });
      result.zoneTemplatesUpserted += 1;
    }
  }

  // 4b. pdns_clusters — must come before pdns_servers so server entries
  // can reference clusters by slug.
  const clusterIdsBySlug = new Map<string, string>();
  if (config.clusters) {
    for (const c of config.clusters) {
      const rows = await db
        .insert(pdnsClusters)
        .values({
          slug: c.slug,
          name: c.name,
          description: c.description ?? null,
          writeStrategy: c.write_strategy,
        })
        .onConflictDoUpdate({
          target: pdnsClusters.slug,
          set: {
            name: c.name,
            description: c.description ?? null,
            writeStrategy: c.write_strategy,
            updatedAt: new Date(),
          },
        })
        .returning({ id: pdnsClusters.id, slug: pdnsClusters.slug });
      const row = rows[0];
      if (row) clusterIdsBySlug.set(row.slug, row.id);
      result.pdnsClustersUpserted += 1;
    }
  }
  // Look up clusters already in the DB but absent from this file (so
  // server entries with cluster_slug resolve cleanly across re-runs).
  if (config.pdns_servers?.some((s) => s.cluster_slug && !clusterIdsBySlug.has(s.cluster_slug))) {
    const existing = await db
      .select({ id: pdnsClusters.id, slug: pdnsClusters.slug })
      .from(pdnsClusters);
    for (const c of existing) clusterIdsBySlug.set(c.slug, c.id);
  }

  // 5. pdns_servers — any role joins a group via cluster_slug (ADR-0014).
  const serverIdsBySlug = new Map<string, string>();
  if (config.pdns_servers) {
    for (const s of config.pdns_servers) {
      const apiKeyEncrypted = encrypt(s.api_key, "pdns-api-key");
      let clusterId: string | null = null;
      if (s.cluster_slug) {
        const id = clusterIdsBySlug.get(s.cluster_slug);
        if (!id) {
          throw new Error(
            `provisioning: server "${s.slug}" references cluster_slug "${s.cluster_slug}" which is not defined and was not found in the database.`,
          );
        }
        clusterId = id;
      }
      const rows = await db
        .insert(pdnsServers)
        .values({
          slug: s.slug,
          name: s.name,
          description: s.description ?? null,
          baseUrl: s.base_url,
          serverId: s.server_id,
          apiKeyEncrypted,
          isDefault: s.is_default,
          clusterId,
        })
        .onConflictDoUpdate({
          target: pdnsServers.slug,
          set: {
            name: s.name,
            description: s.description ?? null,
            baseUrl: s.base_url,
            serverId: s.server_id,
            apiKeyEncrypted,
            isDefault: s.is_default,
            clusterId,
            updatedAt: new Date(),
          },
        })
        .returning({ id: pdnsServers.id, slug: pdnsServers.slug });
      const row = rows[0];
      if (row) serverIdsBySlug.set(row.slug, row.id);
      result.pdnsServersUpserted += 1;
    }

    // Resolve zone-template `default_for_primary_slugs` (server slugs) into
    // ids. Pull in any referenced server already in the DB but absent from
    // this file.
    if (config.zone_templates) {
      const hasUnknown = config.zone_templates
        .flatMap((z) => z.default_for_primary_slugs)
        .some((slug) => !serverIdsBySlug.has(slug));
      if (hasUnknown) {
        const existing = await db
          .select({ id: pdnsServers.id, slug: pdnsServers.slug })
          .from(pdnsServers);
        for (const p of existing) {
          if (!serverIdsBySlug.has(p.slug)) serverIdsBySlug.set(p.slug, p.id);
        }
      }
      for (const z of config.zone_templates) {
        if (z.default_for_primary_slugs.length === 0) continue;
        const ids: string[] = [];
        for (const slug of z.default_for_primary_slugs) {
          const id = serverIdsBySlug.get(slug);
          if (id) ids.push(id);
          else
            logger.warn({ template: z.slug, slug }, "provisioning.zone-template.unknown-primary");
        }
        await db
          .update(zoneTemplates)
          .set({ defaultForPrimaryIds: ids, updatedAt: new Date() })
          .where(eq(zoneTemplates.slug, z.slug));
      }
    }
  }

  // 6. oidc providers
  if (config.oidc) {
    // Pre-load teams + servers so we can resolve group_mappings scope
    // references (slug → id) at write time. The materialised id list is
    // what lives in the JSON column on the row.
    const teamsBySlug = new Map(
      (await db.select({ id: teams.id, slug: teams.slug }).from(teams)).map((r) => [r.slug, r.id]),
    );
    const serversBySlug = new Map(
      (await db.select({ id: pdnsServers.id, slug: pdnsServers.slug }).from(pdnsServers)).map(
        (r) => [r.slug, r.id],
      ),
    );

    // Legacy per-provider `force_default: true` is retired in favour of the
    // single `auth_default_provider` setting. If any OIDC entry still carries
    // the flag, pick the LAST one mentioned in the YAML — same tie-break
    // semantics as the schema migration (last-wins on the storage layer is
    // most recent created; here last-listed approximates that). Log a
    // deprecation so operators clean up their files.
    let legacyForceDefaultSlug: string | null = null;
    for (const p of config.oidc) {
      if (p.force_default && p.enabled !== false) {
        if (legacyForceDefaultSlug !== null) {
          logger.warn(
            {
              previous: legacyForceDefaultSlug,
              superseded: p.slug,
            },
            "provisioning.oidc.force_default-multiple-set",
          );
        }
        legacyForceDefaultSlug = p.slug;
      }
    }
    if (legacyForceDefaultSlug !== null) {
      logger.warn(
        { slug: legacyForceDefaultSlug },
        "provisioning.oidc.force_default-deprecated: translating to settings.auth_default_provider",
      );
      await db
        .insert(settings)
        .values({
          key: "auth_default_provider",
          value: `oidc:${legacyForceDefaultSlug}`,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: settings.key });
    }

    for (const p of config.oidc) {
      const resolvedMappings: OidcGroupMapping[] = [];
      for (const m of p.group_mappings) {
        const parsed = parseScopeString(m.scope);
        if (!parsed) {
          result.unresolvedGroupMappings.push({ provider: p.slug, group: m.group, scope: m.scope });
          continue;
        }
        let scopeId: string | null = null;
        if (parsed.scopeType === "team") {
          const id = teamsBySlug.get(parsed.scopeRef!);
          if (!id) {
            result.unresolvedGroupMappings.push({
              provider: p.slug,
              group: m.group,
              scope: m.scope,
            });
            continue;
          }
          scopeId = id;
        } else if (parsed.scopeType === "server") {
          const id = serversBySlug.get(parsed.scopeRef!);
          if (!id) {
            result.unresolvedGroupMappings.push({
              provider: p.slug,
              group: m.group,
              scope: m.scope,
            });
            continue;
          }
          scopeId = id;
        } else if (parsed.scopeType === "zone") {
          // Zone names live in PDNS, not our DB — store verbatim.
          scopeId = parsed.scopeRef;
        }
        resolvedMappings.push({
          group: m.group,
          roleSlug: m.role,
          scopeType: parsed.scopeType,
          scopeId,
        });
      }

      const clientSecretEncrypted = encrypt(p.client_secret, "oidc-client-secret");
      // Reserve the slug in the cross-type table first. ON CONFLICT DO
      // NOTHING means a re-apply of the same provisioning file is a no-op
      // here; the same operator-supplied slug already maps to "oidc" from
      // a prior run.
      await db
        .insert(authProviderSlugs)
        .values({ slug: p.slug, providerType: "oidc" })
        .onConflictDoNothing({ target: authProviderSlugs.slug });
      await db
        .insert(oidcProviders)
        .values({
          slug: p.slug,
          name: p.name,
          issuerUrl: p.issuer_url,
          clientId: p.client_id,
          clientSecretEncrypted,
          scopes: p.scopes,
          claimEmail: p.claim_email,
          claimName: p.claim_name,
          claimGroups: p.claim_groups,
          enabled: p.enabled,
          iconUrl: p.icon_url ?? null,
          allowedEmailDomains: p.allowed_email_domains ?? null,
          groupMappings: resolvedMappings,
        })
        .onConflictDoUpdate({
          target: oidcProviders.slug,
          set: {
            name: p.name,
            issuerUrl: p.issuer_url,
            clientId: p.client_id,
            clientSecretEncrypted,
            scopes: p.scopes,
            claimEmail: p.claim_email,
            claimName: p.claim_name,
            claimGroups: p.claim_groups,
            enabled: p.enabled,
            iconUrl: p.icon_url ?? null,
            allowedEmailDomains: p.allowed_email_domains ?? null,
            groupMappings: resolvedMappings,
            updatedAt: new Date(),
          },
        });
      result.oidcProvidersUpserted += 1;
    }
  }

  // 6b. saml providers (ADR-0021) — same slug-reservation + upsert pattern
  // as OIDC. Mappings re-use the shared `parseScopeString` resolver.
  if (config.saml) {
    const teamsBySlug = new Map(
      (await db.select({ id: teams.id, slug: teams.slug }).from(teams)).map((r) => [r.slug, r.id]),
    );
    const serversBySlug = new Map(
      (await db.select({ id: pdnsServers.id, slug: pdnsServers.slug }).from(pdnsServers)).map(
        (r) => [r.slug, r.id],
      ),
    );

    for (const p of config.saml) {
      // Both halves of the encryption pair must be set together; reject up
      // front so a malformed YAML doesn't insert a half-configured row.
      if (
        (p.sp_encryption_key && !p.sp_encryption_cert) ||
        (!p.sp_encryption_key && p.sp_encryption_cert)
      ) {
        throw new Error(
          `provisioning: SAML provider "${p.slug}" must set both sp_encryption_key and sp_encryption_cert together, or neither.`,
        );
      }

      const resolvedMappings: SamlGroupMapping[] = [];
      for (const m of p.group_mappings) {
        const parsed = parseScopeString(m.scope);
        if (!parsed) {
          result.unresolvedGroupMappings.push({ provider: p.slug, group: m.group, scope: m.scope });
          continue;
        }
        let scopeId: string | null = null;
        if (parsed.scopeType === "team") {
          const id = teamsBySlug.get(parsed.scopeRef!);
          if (!id) {
            result.unresolvedGroupMappings.push({
              provider: p.slug,
              group: m.group,
              scope: m.scope,
            });
            continue;
          }
          scopeId = id;
        } else if (parsed.scopeType === "server") {
          const id = serversBySlug.get(parsed.scopeRef!);
          if (!id) {
            result.unresolvedGroupMappings.push({
              provider: p.slug,
              group: m.group,
              scope: m.scope,
            });
            continue;
          }
          scopeId = id;
        } else if (parsed.scopeType === "zone") {
          scopeId = parsed.scopeRef;
        }
        resolvedMappings.push({
          group: m.group,
          roleSlug: m.role,
          scopeType: parsed.scopeType,
          scopeId,
        });
      }

      const spSigningKeyEncrypted = encrypt(p.sp_signing_key, "saml-sp-signing-key");
      const spEncryptionKeyEncrypted = p.sp_encryption_key
        ? encrypt(p.sp_encryption_key, "saml-sp-encryption-key")
        : null;

      await db
        .insert(authProviderSlugs)
        .values({ slug: p.slug, providerType: "saml" })
        .onConflictDoNothing({ target: authProviderSlugs.slug });
      await db
        .insert(samlProviders)
        .values({
          slug: p.slug,
          name: p.name,
          idpEntityId: p.idp_entity_id,
          idpSsoUrl: p.idp_sso_url,
          idpSloUrl: p.idp_slo_url ?? null,
          idpSigningCert: p.idp_signing_cert,
          spSigningKeyEncrypted,
          spSigningCert: p.sp_signing_cert,
          spEncryptionKeyEncrypted,
          spEncryptionCert: p.sp_encryption_cert ?? null,
          requireSignedResponse: p.require_signed_response,
          requireEncryptedAssertion: p.require_encrypted_assertion,
          signatureAlgorithm: p.signature_algorithm,
          nameIdFormat: p.name_id_format,
          claimEmail: p.claim_email,
          claimName: p.claim_name,
          claimGroups: p.claim_groups,
          enabled: p.enabled,
          allowedEmailDomains: p.allowed_email_domains ?? null,
          groupMappings: resolvedMappings,
        })
        .onConflictDoUpdate({
          target: samlProviders.slug,
          set: {
            name: p.name,
            idpEntityId: p.idp_entity_id,
            idpSsoUrl: p.idp_sso_url,
            idpSloUrl: p.idp_slo_url ?? null,
            idpSigningCert: p.idp_signing_cert,
            spSigningKeyEncrypted,
            spSigningCert: p.sp_signing_cert,
            spEncryptionKeyEncrypted,
            spEncryptionCert: p.sp_encryption_cert ?? null,
            requireSignedResponse: p.require_signed_response,
            requireEncryptedAssertion: p.require_encrypted_assertion,
            signatureAlgorithm: p.signature_algorithm,
            nameIdFormat: p.name_id_format,
            claimEmail: p.claim_email,
            claimName: p.claim_name,
            claimGroups: p.claim_groups,
            enabled: p.enabled,
            allowedEmailDomains: p.allowed_email_domains ?? null,
            groupMappings: resolvedMappings,
            updatedAt: new Date(),
          },
        });
      result.samlProvidersUpserted += 1;
    }
  }

  // 6c. ldap providers (ADR-0020). Same shape as the OIDC block — slug
  // reservation in `auth_provider_slugs` then a per-provider upsert.
  // Mappings re-use the shared `parseScopeString` resolver because the
  // group-mapping shape is identical to OIDC's.
  if (config.ldap) {
    const teamsBySlug = new Map(
      (await db.select({ id: teams.id, slug: teams.slug }).from(teams)).map((r) => [r.slug, r.id]),
    );
    const serversBySlug = new Map(
      (await db.select({ id: pdnsServers.id, slug: pdnsServers.slug }).from(pdnsServers)).map(
        (r) => [r.slug, r.id],
      ),
    );

    for (const p of config.ldap) {
      const resolvedMappings: LdapGroupMapping[] = [];
      for (const m of p.group_mappings) {
        const parsed = parseScopeString(m.scope);
        if (!parsed) {
          result.unresolvedGroupMappings.push({ provider: p.slug, group: m.group, scope: m.scope });
          continue;
        }
        let scopeId: string | null = null;
        if (parsed.scopeType === "team") {
          const id = teamsBySlug.get(parsed.scopeRef!);
          if (!id) {
            result.unresolvedGroupMappings.push({
              provider: p.slug,
              group: m.group,
              scope: m.scope,
            });
            continue;
          }
          scopeId = id;
        } else if (parsed.scopeType === "server") {
          const id = serversBySlug.get(parsed.scopeRef!);
          if (!id) {
            result.unresolvedGroupMappings.push({
              provider: p.slug,
              group: m.group,
              scope: m.scope,
            });
            continue;
          }
          scopeId = id;
        } else if (parsed.scopeType === "zone") {
          scopeId = parsed.scopeRef;
        }
        resolvedMappings.push({
          group: m.group,
          roleSlug: m.role,
          scopeType: parsed.scopeType,
          scopeId,
        });
      }

      const bindPasswordEncrypted = encrypt(p.bind_password, "ldap-bind-password");
      await db
        .insert(authProviderSlugs)
        .values({ slug: p.slug, providerType: "ldap" })
        .onConflictDoNothing({ target: authProviderSlugs.slug });
      await db
        .insert(ldapProviders)
        .values({
          slug: p.slug,
          name: p.name,
          serverUrl: p.server_url,
          startTls: p.start_tls,
          bindDn: p.bind_dn,
          bindPasswordEncrypted,
          userSearchBase: p.user_search_base,
          userSearchFilter: p.user_search_filter,
          groupSearchBase: p.group_search_base ?? null,
          groupSearchFilter: p.group_search_filter ?? null,
          groupAttr: p.group_attr,
          claimEmail: p.claim_email,
          claimName: p.claim_name,
          tlsCaCert: p.tls_ca_cert ?? null,
          enabled: p.enabled,
          allowedEmailDomains: p.allowed_email_domains ?? null,
          groupMappings: resolvedMappings,
        })
        .onConflictDoUpdate({
          target: ldapProviders.slug,
          set: {
            name: p.name,
            serverUrl: p.server_url,
            startTls: p.start_tls,
            bindDn: p.bind_dn,
            bindPasswordEncrypted,
            userSearchBase: p.user_search_base,
            userSearchFilter: p.user_search_filter,
            groupSearchBase: p.group_search_base ?? null,
            groupSearchFilter: p.group_search_filter ?? null,
            groupAttr: p.group_attr,
            claimEmail: p.claim_email,
            claimName: p.claim_name,
            tlsCaCert: p.tls_ca_cert ?? null,
            enabled: p.enabled,
            allowedEmailDomains: p.allowed_email_domains ?? null,
            groupMappings: resolvedMappings,
            updatedAt: new Date(),
          },
        });
      result.ldapProvidersUpserted += 1;
    }
  }

  // 7. deferred: auth_default_provider. Now that every provider in this
  // file has been upserted (and reserved its slug in auth_provider_slugs),
  // we can resolve a bare-slug shorthand like `auth_default_provider: "company-sso"`
  // to its canonical typed-prefix form (`oidc:company-sso`). Skipping the
  // setting silently when the slug is unknown — provisioning shouldn't
  // crash the apply over an operator typo; the admin UI surfaces "(provider
  // no longer exists)" in the picker if the value ends up dangling.
  if (config.settings?.auth_default_provider !== undefined) {
    const raw = config.settings.auth_default_provider;
    let canonical: string | null = null;
    if (raw === "local") {
      canonical = "local";
    } else if (/^(oidc|saml|ldap):/.test(raw)) {
      // Caller already gave us the typed form — trust it.
      canonical = raw;
    } else {
      // Bare slug. Resolve via the reservation table — this picks up rows
      // freshly inserted in step 6 above.
      const type = await lookupProviderTypeBySlug(raw);
      if (type) {
        canonical = `${type}:${raw}`;
      } else {
        logger.warn(
          { slug: raw },
          "provisioning.auth_default_provider.unknown-slug: skipping; setting left at previous value",
        );
      }
    }
    if (canonical !== null) {
      await db
        .insert(settings)
        .values({ key: "auth_default_provider", value: canonical, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: canonical, updatedAt: new Date() },
        });
      result.settingsWritten += 1;
    }
  }

  // Write the sentinel + audit row. Sentinel goes into the same `settings`
  // table the operator can later poke at to force a re-provision.
  await db
    .insert(settings)
    .values({
      key: "provisioned_at",
      value: { iso: new Date().toISOString(), result },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: { iso: new Date().toISOString(), result },
        updatedAt: new Date(),
      },
    });

  await appendAudit({
    actor: { type: "system", id: null },
    action: "provisioning.applied",
    resource: { type: "setting", id: "provisioned_at" },
    after: {
      ...result,
      unresolvedGroupMappings: result.unresolvedGroupMappings.length,
    },
  });

  if (result.unresolvedGroupMappings.length > 0) {
    logger.warn(
      { count: result.unresolvedGroupMappings.length },
      "provisioning.group_mappings.unresolved-entries-skipped",
    );
  }

  // 7. demo_zones — create synthetic zones on PDNS via the HTTP API. Runs
  // BEFORE the version refresh so the version-cache also reflects the
  // newly-created zone count on first boot. Failures are per-zone; the
  // overall provisioning still succeeds.
  //
  // `touchedPrimaries` accumulates every primary we wrote demo zones to,
  // so the post-loop sweep below can re-NOTIFY their full zone set —
  // catches the docker-compose race where the first zones land on the
  // primary BEFORE the secondaries have registered themselves as
  // supermasters, so the initial NOTIFY had no listener and the demo
  // stack looked desynced until the secondaries' SOA-refresh fired
  // (typically tens of minutes).
  const touchedPrimaries = new Map<string, PdnsServer>();
  if (config.demo_zones) {
    for (const spec of config.demo_zones) {
      await applyDemoZonesEntry(spec, result, touchedPrimaries);
    }
  }

  // Convergence sweep — fire one NOTIFY pass per primary we wrote to.
  // Idempotent; PDNS dedupes by serial so a duplicate NOTIFY just no-ops
  // if the secondary is already current. Best-effort: per-zone failures
  // are logged inside `notifyEveryZoneBestEffort` and never bubble.
  for (const server of touchedPrimaries.values()) {
    try {
      const client = getBackendGateway(server);
      const sweep = await notifyEveryZoneBestEffort(client);
      logger.info({ server: server.slug, ...sweep }, "provisioning.demo_zones.notify-sweep");
    } catch (err) {
      logger.warn(
        { server: server.slug, err: err instanceof Error ? err.message : "unknown" },
        "provisioning.demo_zones.notify-sweep.failed",
      );
    }
  }

  // First-boot UX: probe every freshly-registered PDNS backend so its
  // version_cache + capability flags are populated by the time the
  // operator opens the admin UI. Without this, every backend renders as
  // "never probed" until the operator clicks Refresh all manually.
  // Per-server failures are caught inside `refreshAllBackendsHealth`;
  // a global failure (e.g. PDNS not actually reachable) just logs +
  // doesn't abort the provisioning audit.
  if (result.pdnsServersUpserted > 0) {
    try {
      const { probed, failed } = await refreshAllBackendsHealth();
      logger.info({ probed, failed }, "provisioning.pdns-version-refresh.complete");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "provisioning.pdns-version-refresh.failed",
      );
    }
  }

  // Same first-boot UX for OIDC: probe every provisioned provider's discovery
  // endpoint now, so the dashboard doesn't flash a "never probed" warning in
  // the window before the background discovery sampler first runs. Per-provider
  // failures are caught inside the sampler; a global failure just logs.
  if (result.oidcProvidersUpserted > 0) {
    try {
      const probed = await sampleAllOidcDiscoveryNow();
      logger.info({ probed }, "provisioning.oidc-discovery-refresh.complete");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "provisioning.oidc-discovery-refresh.failed",
      );
    }
  }

  return result;
}

/**
 * Apply one `demo_zones:` generator entry. Resolves the target (server
 * slug → direct, or cluster slug → pick a peer per write strategy), then
 * generates N zones and creates each via the PDNS HTTP API. Idempotent:
 * existing zones surface as a PdnsError on POST and are counted as
 * `skipped`; other errors are counted as `failed` and logged with the
 * specific zone name so the operator can triage.
 */
async function applyDemoZonesEntry(
  spec: NonNullable<ProvisioningConfig["demo_zones"]>[number],
  result: ProvisioningResult,
  /**
   * Shared accumulator across every demo_zones entry. Every primary
   * we successfully wrote to during this run lands here, so the
   * post-provisioning sweep can fire one NOTIFY pass per primary
   * to catch zones whose original NOTIFY raced not-yet-ready
   * secondaries. Keyed by server.id (UUID) so we de-dup the same
   * primary appearing in multiple demo_zones entries.
   */
  touchedPrimaries: Map<string, PdnsServer>,
): Promise<void> {
  // Resolve target → a single PDNS server row + the cluster (if any) for
  // logging context. For cluster targets, we pick ONE peer per zone via
  // the cluster's write strategy (round-robin spreads the 10 cluster
  // zones across 3 peers). All peers share the backend so the data is
  // visible everywhere; the picker just exercises the routing path.
  const targetCluster = spec.target_cluster ? await findClusterBySlug(spec.target_cluster) : null;
  if (spec.target_cluster && !targetCluster) {
    logger.warn(
      { cluster: spec.target_cluster, name_prefix: spec.name_prefix },
      "provisioning.demo_zones.unresolved-cluster",
    );
    result.demoZonesFailed += spec.count;
    return;
  }
  const clusterPeers = targetCluster ? await listActivePeersForCluster(targetCluster.id) : [];
  let directServer = null;
  if (spec.target_server) {
    directServer = await findPdnsServerBySlug(spec.target_server);
    if (!directServer) {
      logger.warn(
        { server: spec.target_server, name_prefix: spec.name_prefix },
        "provisioning.demo_zones.unresolved-server",
      );
      result.demoZonesFailed += spec.count;
      return;
    }
  }

  const zones = generateZones({
    namePrefix: spec.name_prefix,
    baseDomain: spec.base_domain,
    count: spec.count,
    recordsPerZone: spec.records_per_zone,
    ...(spec.nameservers ? { nameservers: spec.nameservers } : {}),
  });

  for (const z of zones) {
    let server = directServer;
    if (!server && targetCluster) {
      server = await choosePeer(targetCluster, clusterPeers);
      if (!server) {
        logger.warn(
          { cluster: targetCluster.slug, zone: z.name },
          "provisioning.demo_zones.no-active-peer",
        );
        result.demoZonesFailed += 1;
        continue;
      }
    }
    if (!server) {
      result.demoZonesFailed += 1;
      continue;
    }

    try {
      const client = getBackendGateway(server);
      await createZoneAndNotify(client, {
        name: z.name,
        kind: spec.kind,
        nameservers: z.nameservers,
        rrsets: z.rrsets,
      });
      result.demoZonesCreated += 1;
      // Track which primaries we wrote to so the post-loop sweep
      // below can NOTIFY their entire zone set — handles the race
      // where the first few zones got created BEFORE the secondaries
      // had registered themselves as supermasters and so missed the
      // initial NOTIFY.
      touchedPrimaries.set(server.id, server);
      logger.info(
        {
          zone: z.name,
          server: server.slug,
          cluster: targetCluster?.slug ?? null,
          rrsets: z.rrsets.length,
        },
        "provisioning.demo_zones.zone-created",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // PDNS returns 409 (Conflict) for an existing zone — the message
      // contains "already exists" or similar. Treat as skipped so a
      // re-run is silent rather than alarming.
      if (/already exists|conflict|409/i.test(msg)) {
        result.demoZonesSkipped += 1;
        continue;
      }
      result.demoZonesFailed += 1;
      logger.warn(
        { zone: z.name, server: server.slug, err: msg },
        "provisioning.demo_zones.zone-create-failed",
      );
    }
  }
}

/**
 * Check whether the database has been provisioned before. Used by the boot
 * path to decide whether to apply the file or skip.
 */
export async function isProvisioned(): Promise<boolean> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "provisioned_at"))
    .limit(1);
  return rows.length > 0;
}

// Touch `sql` so the import isn't flagged unused even if a later edit drops
// the only reference. Cheap defence against churn.
void sql;
