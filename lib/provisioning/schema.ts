/**
 * lib/provisioning/schema.ts
 *
 * Zod schema for `provisioning.yaml`. Every top-level section is optional —
 * an operator who only wants to seed OIDC and PDNS servers can leave the
 * other blocks out. Unknown keys are rejected so typos don't silently
 * become a no-op.
 *
 * See `provisioning.example.yaml` for the canonical example + per-section
 * commentary.
 */

import "server-only";
import { z } from "zod";
import { KNOWN_SETTING_KEYS, SETTING_VALUE_SCHEMAS } from "@/lib/validators/settings";

/**
 * Provisioning-relaxed schema for `auth_default_provider`. The strict
 * runtime validator (`SETTING_VALUE_SCHEMAS.auth_default_provider`) only
 * accepts `local` | `<type>:<slug>`; here we also accept a bare provider
 * slug so operators can write `auth_default_provider: "company-sso"` in
 * the YAML without knowing which protocol the provider speaks. The
 * applier resolves the bare form against `auth_provider_slugs` and
 * persists the canonical `<type>:<slug>` form.
 */
const provisioningAuthDefaultProvider = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(local|(?:oidc|saml|ldap):[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/,
    "Must be 'local', a typed-prefix form ('<type>:<slug>'), or a bare provider slug.",
  );

/** Section: top-level KV writes to the `settings` table. */
const settingsSection = z
  .object({
    ...(Object.fromEntries(
      KNOWN_SETTING_KEYS.filter((k) => k !== "auth_default_provider").map((k) => [
        k,
        SETTING_VALUE_SCHEMAS[k].optional(),
      ]),
    ) as {
      [K in Exclude<(typeof KNOWN_SETTING_KEYS)[number], "auth_default_provider">]: z.ZodOptional<
        (typeof SETTING_VALUE_SCHEMAS)[K]
      >;
    }),
    auth_default_provider: provisioningAuthDefaultProvider.optional(),
  })
  .strict();

const roleEntry = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, "slug must be lowercase kebab-case"),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    requires_mfa: z.boolean().default(false),
    /** Permission strings from `lib/rbac/permissions.ts`. Validated as
     *  free-form strings here; the runtime ability builder checks them
     *  against the vocabulary at sign-in. */
    permissions: z.array(z.string().min(1)).min(1),
  })
  .strict();

const teamEntry = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9](-?[a-z0-9])*$/, "slug must be lowercase kebab"),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    contact: z.string().max(500).optional(),
    mail: z.string().max(500).optional(),
  })
  .strict();

const templateRecord = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1).max(16),
    ttl: z.number().int().min(1).max(2147483647),
    content: z.string().min(1),
    disabled: z.boolean().default(false),
  })
  .strict();

const zoneTemplateEntry = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    soa_ttl: z.number().int().min(60).default(3600),
    soa_refresh: z.number().int().min(60).default(3600),
    soa_retry: z.number().int().min(60).default(900),
    soa_expire: z.number().int().min(3600).default(604800),
    soa_minimum: z.number().int().min(60).default(3600),
    nameservers: z.array(z.string().min(1)).default([]),
    records: z.array(templateRecord).default([]),
    kind: z.enum(["Native", "Master", "Slave", "Primary", "Secondary"]).default("Native"),
    soa_edit: z.string().optional(),
    soa_edit_api: z.string().optional(),
    api_rectify: z.boolean().optional(),
    metadata: z.record(z.string(), z.array(z.string())).default({}),
    default_for_primary_slugs: z.array(z.string().min(1)).default([]),
  })
  .strict();

const pdnsClusterEntry = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    write_strategy: z
      .enum(["round_robin", "lowest_latency", "random", "least_load"])
      .default("round_robin"),
  })
  .strict();

const pdnsServerEntry = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    base_url: z.string().url(),
    server_id: z.string().min(1).default("localhost"),
    /** PDNS X-API-Key, plaintext in YAML. Encrypted before write. */
    api_key: z.string().min(1),
    is_default: z.boolean().default(false),
    /** Group membership (ADR-0014). References a cluster slug from the
     *  `clusters:` section above. A backend's primary/secondary nature is
     *  OBSERVED from its `/config`, not declared here: group the writable
     *  peers of a multi-primary cluster, or a primary together with its
     *  secondaries. The precise edges are derived from each zone's masters. */
    cluster_slug: z.string().min(1).optional(),
  })
  .strict();

/**
 * Demo-zone generator. Produces N synthetic zones, each with a handful of
 * realistic records (apex A, www, mail, MX, SPF TXT, a few hosts, a CNAME).
 * Lands on a single target — either a specific server (`target_server`)
 * or any peer in a cluster (`target_cluster`, picked via the cluster's
 * write strategy). Exactly one of the two must be set.
 *
 * Idempotent: zones that already exist on PDNS are caught + skipped, so
 * re-running the applier after a fresh boot doesn't double-create.
 */
const demoZonesEntry = z
  .object({
    /** Server slug to land all generated zones on. Mutually exclusive
     *  with `target_cluster`. */
    target_server: z.string().min(1).optional(),
    /** Cluster slug — applier picks a peer per the cluster's strategy.
     *  Mutually exclusive with `target_server`. */
    target_cluster: z.string().min(1).optional(),
    count: z.number().int().min(1).max(500).default(10),
    /** Records per zone (excluding the implicit SOA + NS). 1..100. */
    records_per_zone: z.number().int().min(1).max(100).default(10),
    /** Zone-name prefix: produces `<prefix>-<i>.<base_domain>.` */
    name_prefix: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9-]*$/),
    /** Apex of the generated zones. Defaults to `demo`. */
    base_domain: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9.-]+$/)
      .default("demo"),
    /** Wire-format zone kind. Defaults to Master (PDNS API still requires
     *  the legacy spelling). */
    kind: z.enum(["Native", "Master", "Primary"]).default("Master"),
    /**
     * NS hostnames written into every generated zone. When unset, the
     * generator falls back to `ns1.<base_domain>.` + `ns2.<base_domain>.`.
     *
     * For a Primary + Secondaries topology you MUST list every
     * Secondary's supermaster-registered nameserver here (the value
     * each Secondary's `SELF_NS` env in compose). PDNS' auto-secondary
     * verification on NOTIFY rejects the auto-create when none of the
     * zone's NS records match the receiving Secondary's
     * supermasters.nameserver row, so all Secondaries need to be
     * representable in the NS list.
     */
    nameservers: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((z) => Boolean(z.target_server) !== Boolean(z.target_cluster), {
    message: "demo_zones entry must set exactly one of target_server / target_cluster",
  });

const oidcGroupMapping = z
  .object({
    group: z.string().min(1),
    role: z.string().min(1),
    scope: z.string().min(1),
  })
  .strict();

const oidcProviderEntry = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(120),
    issuer_url: z.string().url(),
    client_id: z.string().min(1),
    /** Plaintext in YAML; encrypted before write. */
    client_secret: z.string().min(1),
    scopes: z.string().default("openid profile email"),
    claim_email: z.string().default("email"),
    claim_name: z.string().default("name"),
    claim_groups: z.string().default("groups"),
    enabled: z.boolean().default(true),
    force_default: z.boolean().default(false),
    icon_url: z.string().url().optional(),
    allowed_email_domains: z.array(z.string().min(1)).optional(),
    group_mappings: z.array(oidcGroupMapping).default([]),
  })
  .strict();

const samlGroupMapping = z
  .object({
    group: z.string().min(1),
    role: z.string().min(1),
    scope: z.string().min(1),
  })
  .strict();

const samlProviderEntry = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(120),
    idp_entity_id: z.string().min(1),
    idp_sso_url: z.string().url(),
    idp_slo_url: z.string().url().optional(),
    /** PEM cert text; multi-line in YAML via | block style. */
    idp_signing_cert: z.string().min(1),
    /** SP private key PEM. Plaintext in YAML; encrypted before write. */
    sp_signing_key: z.string().min(1),
    sp_signing_cert: z.string().min(1),
    /** Optional encryption keypair — both required if either set. Validated
     *  in the applier so the YAML error reports the field name accurately. */
    sp_encryption_key: z.string().min(1).optional(),
    sp_encryption_cert: z.string().min(1).optional(),
    require_signed_response: z.boolean().default(true),
    require_encrypted_assertion: z.boolean().default(false),
    signature_algorithm: z.enum(["sha1", "sha256", "sha512"]).default("sha256"),
    name_id_format: z
      .string()
      .min(1)
      .default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
    claim_email: z.string().default("email"),
    claim_name: z.string().default("name"),
    claim_groups: z.string().default("groups"),
    enabled: z.boolean().default(true),
    allowed_email_domains: z.array(z.string().min(1)).optional(),
    group_mappings: z.array(samlGroupMapping).default([]),
  })
  .strict();

export const provisioningSchema = z
  .object({
    /**
     * When set, refuses to apply the file unless the running app's version
     * starts with this prefix. Belt-and-braces for the "we changed the
     * schema, your IaC is now stale" failure mode. Optional.
     */
    version: z.string().optional(),
    settings: settingsSection.optional(),
    roles: z.array(roleEntry).optional(),
    teams: z.array(teamEntry).optional(),
    zone_templates: z.array(zoneTemplateEntry).optional(),
    clusters: z.array(pdnsClusterEntry).optional(),
    pdns_servers: z.array(pdnsServerEntry).optional(),
    /** Generated demo zones — applied via the PDNS HTTP API after the
     *  backends are registered. See `demoZonesEntry`. */
    demo_zones: z.array(demoZonesEntry).optional(),
    oidc: z.array(oidcProviderEntry).optional(),
    saml: z.array(samlProviderEntry).optional(),
  })
  .strict();

export type ProvisioningConfig = z.infer<typeof provisioningSchema>;
export type ProvisioningSamlProviderEntry = z.infer<typeof samlProviderEntry>;
export type ProvisioningSamlGroupMapping = z.infer<typeof samlGroupMapping>;
export type ProvisioningRoleEntry = z.infer<typeof roleEntry>;
export type ProvisioningTeamEntry = z.infer<typeof teamEntry>;
export type ProvisioningZoneTemplateEntry = z.infer<typeof zoneTemplateEntry>;
export type ProvisioningPdnsClusterEntry = z.infer<typeof pdnsClusterEntry>;
export type ProvisioningPdnsServerEntry = z.infer<typeof pdnsServerEntry>;
export type ProvisioningDemoZonesEntry = z.infer<typeof demoZonesEntry>;
export type ProvisioningOidcProviderEntry = z.infer<typeof oidcProviderEntry>;
export type ProvisioningOidcGroupMapping = z.infer<typeof oidcGroupMapping>;

/**
 * Parse a `scope` string from a group mapping into the (type, id) pair the
 * `role_assignments` table expects. Supported forms:
 *
 *   global
 *   team:<slug>
 *   zone:<zone-name>
 *   server:<slug>
 */
export function parseScopeString(scope: string): {
  scopeType: "global" | "team" | "zone" | "server";
  scopeRef: string | null;
} | null {
  if (scope === "global") return { scopeType: "global", scopeRef: null };
  const colon = scope.indexOf(":");
  if (colon === -1) return null;
  const kind = scope.slice(0, colon).trim().toLowerCase();
  const ref = scope.slice(colon + 1).trim();
  if (!ref) return null;
  if (kind === "team" || kind === "zone" || kind === "server") {
    return { scopeType: kind, scopeRef: ref };
  }
  return null;
}
