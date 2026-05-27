/**
 * lib/env.ts
 *
 * Single source of truth for environment-derived configuration. Every other module
 * imports validated values from here; nobody else reads `process.env` directly.
 *
 * The schema below is validated once at boot. If anything required is missing or
 * malformed the app **refuses to start** with a clear error message. This converts
 * misconfiguration into a startup failure instead of a runtime surprise three days
 * after deploy.
 *
 * The `_FILE` suffix convention is preserved from the older systems: any required env
 * variable can be provided either inline (`FOO=bar`) or by pointing at a file
 * (`FOO_FILE=/run/secrets/foo`). This is how Docker / Kubernetes inject secrets.
 *
 * Why module-scope side effects: the env is validated at import time so the app
 * cannot lazily defer the failure. If you change the schema, every test that imports
 * `env` will fail fast — that's the intended behavior.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

// =============================================================================
// File-suffix resolution
// =============================================================================

/**
 * Resolve `KEY` from either `process.env.KEY` or `process.env.KEY_FILE`. If both
 * are set, the inline value wins and a warning is emitted. If neither is set the
 * value is `undefined`, which the Zod schema below will catch for required keys.
 *
 * @example
 *   APP_SECRET_KEY=abc123          → "abc123"
 *   APP_SECRET_KEY_FILE=/path/to/k → contents of /path/to/k, stripped of trailing newline
 */
function readEnvWithFileSuffix(key: string): string | undefined {
  const inlineValue = process.env[key];
  const fileKey = `${key}_FILE`;
  const filePath = process.env[fileKey];

  if (inlineValue && filePath) {
    console.warn(
      `[env] Both ${key} and ${fileKey} are set. Using inline ${key}; ignoring ${fileKey}.`,
    );
    return inlineValue;
  }

  if (inlineValue) return inlineValue;
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").trimEnd();
    } catch (cause) {
      throw new Error(
        `[env] ${fileKey}=${filePath} but the file could not be read: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
  }
  return undefined;
}

function collectEnv(keys: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of keys) {
    out[key] = readEnvWithFileSuffix(key);
  }
  return out;
}

// =============================================================================
// Schema
// =============================================================================

const secretKey = z
  .string()
  .min(32, "must be at least 32 characters (generate with: openssl rand -base64 32)")
  .refine((s) => !/^(changeme|secret|key|password|test|dev)$/i.test(s), {
    message: "looks like a placeholder. Generate a real secret with: openssl rand -base64 32",
  });

const envSchema = z.object({
  // --- Runtime ---
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z
    .string()
    .url("APP_URL must be a fully-qualified URL with no trailing slash")
    .refine((u) => !u.endsWith("/"), "APP_URL must not end with a trailing slash"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // --- Secrets ---
  APP_SECRET_KEY: secretKey,
  // `lib/crypto/encryption.ts deriveKey` base64-decodes this and requires
  // >=32 BYTES. A 32-char base64 string decodes to only 24 bytes — it would
  // pass `secretKey`'s min(32)-CHARS check at boot but throw at first use.
  // Refine here so the misconfig fails loudly at boot, matching env.ts's intent.
  APP_ENCRYPTION_KEY: secretKey.refine((s) => Buffer.from(s, "base64").length >= 32, {
    message:
      "must base64-decode to at least 32 bytes (generate with: openssl rand -base64 32; a 32-char base64 string is only 24 bytes)",
  }),

  // --- Database ---
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection URL"),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),

  // --- Redis (optional — enables HA across replicas, ADR-0016) ---
  // When set, the rate limiter, the realtime SSE event-bus, and the reveal-once
  // token store coordinate through Redis so they work across >1 replica. Unset =
  // single-instance (all three run in-process). A multi-replica deploy needs
  // BOTH this and a shared Postgres `DATABASE_URL`; SQLite is single-instance.
  REDIS_URL: z.string().url().optional(),

  // --- Sessions ---
  // Session TTL in seconds. Default: 12h. Configurable per-deployment.
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43200),
  // Cookie domain. Default: derive from APP_URL host. Set explicitly for
  // multi-subdomain SSO scenarios.
  COOKIE_DOMAIN: z.string().optional(),

  // --- Local auth ---
  // Whether email + password sign-in is enabled at all. Default true.
  LOCAL_AUTH_ENABLED: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(true),
  // Public self-service signup. Default false — admin must create users.
  SIGNUP_ENABLED: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(false),
  /**
   * Role (by slug) assigned to every self-service signup. Defaults to the
   * seeded low-privilege `read-only` role. This is the ONLY role a signup
   * ever receives — there is no path from public signup to an admin role.
   *
   * The slug's existence and low-privilege nature are verified at boot by the
   * seed step (`scripts/seed.ts`), AFTER the system roles are upserted: if the
   * configured role is missing or holds an admin-equivalent permission, the
   * boot fails loudly. We can't validate it here in the env schema because the
   * check needs the DB (the role table), which isn't available at env-parse
   * time. See `lib/auth/signup-policy.ts` for the pure low-privilege predicate.
   */
  SIGNUP_DEFAULT_ROLE: z.string().min(1).default("read-only"),
  /**
   * Comma-separated email-domain allow-list for self-service signups. Mirrors
   * `OIDC_ALLOWED_EMAIL_DOMAINS`: empty / unset means "any domain". Matching is
   * case-insensitive on the part after the rightmost `@`, exact-domain only
   * (a subdomain needs its own entry). Enforced before any user row is created.
   */
  SIGNUP_ALLOWED_EMAIL_DOMAINS: z
    .string()
    .optional()
    .transform((s) =>
      (s ?? "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0),
    )
    .pipe(z.array(z.string())),

  // --- Bootstrap admin (run on seed if no users exist) ---
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),

  // --- OIDC (one provider later; multi-provider later) ---
  OIDC_ENABLED: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(false),
  /** Stable slug used in the callback URL (`/api/auth/oidc/<id>/callback`). */
  OIDC_PROVIDER_ID: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  /** Display name shown on the login page. */
  OIDC_PROVIDER_NAME: z.string().optional(),
  /** Issuer URL — used for OIDC discovery. */
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default("openid profile email"),
  // Claim mapping. Defaults are the standard claims.
  OIDC_CLAIM_USERNAME: z.string().default("email"),
  OIDC_CLAIM_EMAIL: z.string().default("email"),
  OIDC_CLAIM_NAME: z.string().default("name"),
  /**
   * Optional allow-list for OIDC user auto-provisioning. Comma-separated
   * list of email domains (e.g. `example.com, contractors.example.com`).
   * When set, an OIDC sign-in for a brand-new email outside this list is
   * rejected before a local user row is created. Existing users keep
   * signing in regardless.
   *
   * Empty / unset means "no restriction" — preservesbehavior.
   * Matching is case-insensitive on the part after `@`.
   */
  OIDC_ALLOWED_EMAIL_DOMAINS: z
    .string()
    .optional()
    .transform((s) =>
      (s ?? "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0),
    )
    .pipe(z.array(z.string())),

  // --- Captcha ---
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // Reverse-proxy IP attribution is unconditional: the app always reads
  // `X-Forwarded-For` / `X-Real-IP` (see `lib/client-ip.ts`). The deployment
  // contract is that a fronting proxy overwrites client-supplied XFF; there is
  // no TRUST_PROXY toggle.

  // --- PDNS connectivity ---
  // SSRF guard. When false (default in production), the admin "add PDNS
  // server" form refuses URLs that resolve to loopback / RFC1918 / CGNAT /
  // IPv6 ULA addresses, and the HTTP client re-resolves before every request
  // as DNS-rebinding defense. Link-local (incl. 169.254.169.254 cloud
  // metadata) is always blocked regardless of this setting.
  //
  // Set to `true` for in-cluster PDNS reached via a private hostname or for
  // the docker-compose dev stack (`http://pdns:8081/api/v1`). The default is
  // `true` in non-production, `false` in production — see lib/pdns/url-safety.ts.
  APP_PDNS_ALLOW_PRIVATE_NETWORKS: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .optional(),

  // When false (default in production), the SSRF guard refuses PDNS
  // base URLs that don't use https://. Set to `true` for an internal
  // PDNS reached over a private network where TLS isn't terminated at
  // the PDNS endpoint (a common docker-compose / homelab shape). Note:
  // this only relaxes the scheme check; the IP-range guard is still
  // governed by `APP_PDNS_ALLOW_PRIVATE_NETWORKS`. Both must be opted in
  // for an http://internal-host:port URL to be accepted.
  APP_PDNS_ALLOW_INSECURE_HTTP: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .optional(),

  // Background polling of PDNS backends — opt-in supplementary features.
  //
  // When TRUE, the unified background poller ticks on a 30 s zone-state /
  // 60 s daemon refresh / 5 min metric-sample schedule and powers:
  //   • Header SYNCED / DESYNCED chip
  //   • Zone-detail "Sync" + "Statistics" tabs
  //   • Zone-list mirror-state column
  //   • Servers-list lag column
  //   • Dashboard "PDNS metrics" tab (time-series graphs)
  //   • Background drift-derived advisories in the bell
  //
  // When FALSE (default), AuthAdmin only talks to PDNS in response to user
  // actions — every page render warms what it needs on demand, every Test /
  // Refresh All is a one-shot, mutations publish their own SSE refresh.
  // The supplementary surfaces above hide; the rest of the app (zone CRUD,
  // DNSSEC, TSIG, autoprimaries, audit, RBAC, OIDC, …) is unchanged.
  // Recommended for single-server / standalone PDNS deployments where
  // there is no replication topology for the poller to be aware of.
  // REQUIRED for primary+secondaries and multi-primary cluster operators who
  // want AuthAdmin to surface replication drift.
  PDNS_BACKGROUND_POLLING: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .optional(),

  // --- OIDC issuer connectivity (SSRF guard, mirrors the PDNS pair) ---
  // The OIDC issuer/discovery URL is operator-supplied and fetched server-side
  // (probe + live discovery), so it runs through the same outbound-URL guard.
  // When false (default in prod) the guard refuses an issuer that resolves to a
  // private address; link-local / cloud-metadata is always blocked. Set true for
  // an internal IdP reached over a private network.
  APP_OIDC_ALLOW_PRIVATE_NETWORKS: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .optional(),
  // Relax the https-in-production scheme check for the OIDC issuer URL. Set true
  // only for an internal IdP without TLS at the endpoint.
  APP_OIDC_ALLOW_INSECURE_HTTP: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .optional(),

  // --- Email / SMTP ---
  // All SMTP knobs are optional. With SMTP_HOST unset, the email
  // module no-ops (calls are still safe to make; they log and return
  // false). With SMTP_HOST set, the transport is built from the rest
  // of the SMTP_* env using these conventions:
  //
  //   • Encryption:
  //       SMTP_SECURE=true            → implicit TLS from open (SMTPS,
  //                                     port 465 by convention)
  //       SMTP_STARTTLS=required      → connect plaintext, STARTTLS or
  //                                     refuse to send (port 587 / 25)
  //       SMTP_STARTTLS=opportunistic → STARTTLS if offered, else
  //                                     plaintext (default; matches
  //                                     RFC 3207 "MAY")
  //       SMTP_STARTTLS=disabled      → plaintext only, never STARTTLS
  //                                     (for local relays / fakemail)
  //     Setting both SMTP_SECURE=true AND SMTP_STARTTLS=required is an
  //     error — pick one.
  //
  //   • Auth (optional): SMTP_USERNAME + SMTP_PASSWORD. If only one is
  //     set, that's an error. If neither is set, auth is skipped — the
  //     relay must allow unauthenticated submission from the app's IP.
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURE: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(false),
  SMTP_STARTTLS: z.enum(["required", "opportunistic", "disabled"]).default("opportunistic"),
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** RFC 5321 envelope sender. Required when SMTP_HOST is set. */
  SMTP_FROM: z.string().email().optional(),
  /** Optional override for the human-readable display name on outbound
   *  messages — `<SMTP_FROM_NAME> <SMTP_FROM@example.com>`. */
  SMTP_FROM_NAME: z.string().min(1).optional(),
  /** Reject self-signed / mismatched certificates. Default true; set
   *  to "false" only for local fakemail servers. */
  SMTP_TLS_REJECT_UNAUTHORIZED: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(true),
  /** Per-message timeout in ms (default 10s). */
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),

  // --- Telemetry ---
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  METRICS_ENABLED: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(true),
  /**
   * Bearer token required to scrape `/metrics`. Pin one in env for stable
   * scrape configs; if unset (and METRICS_ENABLED is true), the app
   * generates a random 32-char token on every boot and logs it once so the
   * endpoint is never accidentally open on a shared LAN. To opt out of
   * /metrics entirely, set METRICS_ENABLED=false.
   */
  METRICS_TOKEN: z.string().min(16).optional(),

  // --- WebAuthn / passkeys ---
  /** Master kill-switch for the WebAuthn surface (login + profile enrolment). */
  WEBAUTHN_ENABLED: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(true),
  /**
   * Relying-Party identifier. Must equal the `origin` hostname the browser
   * uses to reach the app (NOT a URL, NOT a path — just the host). Derives
   * from `APP_URL` host when unset, which is correct for ~all single-host
   * deployments. Override only for apex/sub-domain sharing (e.g. set
   * `example.com` so credentials registered at `auth.example.com` work at
   * `dns.example.com`).
   */
  WEBAUTHN_RP_ID: z
    .string()
    .min(1)
    .refine(
      (s) => !s.includes("://") && !s.startsWith("/"),
      "WEBAUTHN_RP_ID must be a bare host, not a URL",
    )
    .optional(),
  /**
   * Display name browsers/OS show during registration ("Add a passkey
   * for X"). Defaults to the configured site name (`settings.site_name`)
   * at request time, with `"PowerDNS-AuthAdmin"` as the literal fallback
   * when the settings table is unreachable.
   */
  WEBAUTHN_RP_NAME: z.string().min(1).optional(),
  /** User-verification policy passed to the authenticator. */
  WEBAUTHN_USER_VERIFICATION: z.enum(["required", "preferred", "discouraged"]).default("preferred"),
  /**
   * Attestation conveyance preference. Default `none` keeps the privacy-
   * preserving posture; `direct` is for audit-grade deployments that want
   * attestation statements for compliance. (SimpleWebAuthn v13 dropped
   * `"indirect"`; use `"direct"` or `"none"`.)
   */
  WEBAUTHN_ATTESTATION: z.enum(["none", "direct"]).default("none"),
  /**
   * Opt-in to allow non-localhost http:// origins (LAN development without
   * TLS). Default false — production deployments serve over HTTPS and have
   * no business loosening this.
   */
  WEBAUTHN_ALLOW_INSECURE_ORIGINS: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(false),

  // --- Provisioning (first-boot IaC) ---
  /**
   * Path to a YAML file applied on first boot. The applier writes a
   * sentinel into the `settings` table (`provisioned_at`) on success;
   * subsequent restarts skip the file. Drop the sentinel row to
   * re-provision. See ADR-0012 and `provisioning.example.yaml`.
   *
   * Unset = no provisioning is attempted (the admin UI is the only
   * source of truth).
   */
  PROVISIONING_FILE: z.string().min(1).optional(),
  /**
   * Whether the app container's entrypoint should run provisioning
   * after migrations. Default true. Operators using an out-of-band
   * provisioning workflow set this to "false".
   */
  PROVISION_ON_BOOT: z
    .string()
    .transform((s) => s.toLowerCase() === "true")
    .pipe(z.boolean())
    .default(true),
});

export type Env = z.infer<typeof envSchema>;

// =============================================================================
// Boot-time validation
// =============================================================================

const ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "APP_URL",
  "LOG_LEVEL",
  "APP_SECRET_KEY",
  "APP_ENCRYPTION_KEY",
  "DATABASE_URL",
  "DATABASE_POOL_SIZE",
  "REDIS_URL",
  "SESSION_TTL_SECONDS",
  "COOKIE_DOMAIN",
  "LOCAL_AUTH_ENABLED",
  "SIGNUP_ENABLED",
  "SIGNUP_DEFAULT_ROLE",
  "SIGNUP_ALLOWED_EMAIL_DOMAINS",
  "BOOTSTRAP_ADMIN_EMAIL",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "OIDC_ENABLED",
  "OIDC_PROVIDER_ID",
  "OIDC_PROVIDER_NAME",
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_SCOPES",
  "OIDC_CLAIM_USERNAME",
  "OIDC_CLAIM_EMAIL",
  "OIDC_CLAIM_NAME",
  "OIDC_ALLOWED_EMAIL_DOMAINS",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "APP_PDNS_ALLOW_PRIVATE_NETWORKS",
  "APP_PDNS_ALLOW_INSECURE_HTTP",
  "PDNS_BACKGROUND_POLLING",
  "APP_OIDC_ALLOW_PRIVATE_NETWORKS",
  "APP_OIDC_ALLOW_INSECURE_HTTP",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_STARTTLS",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "SMTP_FROM_NAME",
  "SMTP_TLS_REJECT_UNAUTHORIZED",
  "SMTP_TIMEOUT_MS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "METRICS_ENABLED",
  "METRICS_TOKEN",
  "WEBAUTHN_ENABLED",
  "WEBAUTHN_RP_ID",
  "WEBAUTHN_RP_NAME",
  "WEBAUTHN_USER_VERIFICATION",
  "WEBAUTHN_ATTESTATION",
  "WEBAUTHN_ALLOW_INSECURE_ORIGINS",
  "PROVISIONING_FILE",
  "PROVISION_ON_BOOT",
] as const;

/**
 * Marker substring that identifies the build-time placeholder values
 * below. Used by `detectBuildTimePlaceholders` to refuse to start the
 * runtime if a placeholder somehow leaks into the deployed image — see
 * S-9 in reports/audit-2026-05-16.md.
 *
 * Keep this in sync with the literals in `injectBuildTimePlaceholders`.
 */
export const BUILD_TIME_PLACEHOLDER_MARK = "build-time-placeholder";

/**
 * During `next build`, Next imports route modules to extract metadata. Those
 * route modules transitively import this file. Real env values aren't
 * available to the build (and shouldn't be — secrets stay out of build
 * artifacts), so we substitute placeholders for the four required keys.
 *
 * These placeholders MUST NOT survive into runtime. The
 * `detectBuildTimePlaceholders` check below refuses to boot the app if any
 * of them are still present after Zod validation, so a deploy that
 * accidentally inherits `NEXT_PHASE=phase-production-build` (or otherwise
 * leaves the placeholder in place) fails loudly instead of silently
 * booting with a shared fixed key — which would let any attacker who
 * cracked the placeholder forge sessions across deployments.
 */
function injectBuildTimePlaceholders(): void {
  if (process.env["NEXT_PHASE"] !== "phase-production-build") return;
  process.env["APP_URL"] ??= "http://localhost:3000";
  process.env["APP_SECRET_KEY"] ??=
    `${BUILD_TIME_PLACEHOLDER_MARK}-not-used-at-runtime-please-do-not-deploy`;
  process.env["APP_ENCRYPTION_KEY"] ??=
    `${BUILD_TIME_PLACEHOLDER_MARK}-not-used-at-runtime-please-do-not-deploy`;
  process.env["DATABASE_URL"] ??= "postgres://build:build@localhost:5432/build";
}

/**
 * Inspect a parsed env for build-time placeholders that have leaked into
 * runtime. Returns the list of violating keys (empty when clean). Pure —
 * easy to unit-test without poking module-level state.
 *
 * `DATABASE_URL` is checked for the literal `build:build@` username/host
 * pattern rather than the marker because the URL has its own placeholder
 * shape that doesn't contain the marker substring.
 */
export function detectBuildTimePlaceholders(input: {
  APP_SECRET_KEY: string;
  APP_ENCRYPTION_KEY: string;
  DATABASE_URL: string;
  isBuildPhase: boolean;
}): string[] {
  if (input.isBuildPhase) return [];
  const violations: string[] = [];
  if (input.APP_SECRET_KEY.includes(BUILD_TIME_PLACEHOLDER_MARK)) {
    violations.push("APP_SECRET_KEY");
  }
  if (input.APP_ENCRYPTION_KEY.includes(BUILD_TIME_PLACEHOLDER_MARK)) {
    violations.push("APP_ENCRYPTION_KEY");
  }
  if (input.DATABASE_URL.includes("postgres://build:build@")) {
    violations.push("DATABASE_URL");
  }
  return violations;
}

function parseEnv(): Env {
  injectBuildTimePlaceholders();
  const raw = collectEnv(ENV_KEYS);
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    const message =
      "\n[env] Environment validation failed. The app cannot start.\n\n" +
      `${issues}\n\n` +
      "See .env.example for the full list of supported variables.\n";

    console.error(message);
    // Throw so callers can surface the failure cleanly. The server entrypoint
    // bubbles this to a crash — same effect as `process.exit` but lets tests
    // import this module without killing the test runner.
    throw new Error(message);
  }

  const parsed = result.data;

  // Cross-field sanity checks the schema can't express alone. Skipped during
  // the build phase since OIDC/bootstrap env are intentionally absent then.
  const isBuildPhase = process.env["NEXT_PHASE"] === "phase-production-build";

  if (!isBuildPhase && parsed.OIDC_ENABLED) {
    const required = [
      "OIDC_PROVIDER_ID",
      "OIDC_PROVIDER_NAME",
      "OIDC_ISSUER_URL",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
    ] as const;
    const missing = required.filter((k) => !parsed[k]);
    if (missing.length > 0) {
      const msg = `\n[env] OIDC_ENABLED=true but missing required keys: ${missing.join(", ")}\n`;

      console.error(msg);
      throw new Error(msg);
    }
  }

  if (!isBuildPhase && parsed.SMTP_HOST) {
    const smtpErrors: string[] = [];
    if (!parsed.SMTP_FROM) {
      smtpErrors.push("SMTP_HOST is set but SMTP_FROM is missing.");
    }
    if (parsed.SMTP_SECURE && parsed.SMTP_STARTTLS === "required") {
      smtpErrors.push(
        "SMTP_SECURE=true (implicit TLS) is incompatible with SMTP_STARTTLS=required — pick one.",
      );
    }
    if (Boolean(parsed.SMTP_USERNAME) !== Boolean(parsed.SMTP_PASSWORD)) {
      smtpErrors.push("SMTP_USERNAME and SMTP_PASSWORD must be set together (or neither).");
    }
    if (smtpErrors.length > 0) {
      const msg =
        "\n[env] SMTP configuration is invalid:\n" +
        smtpErrors.map((e) => `  • ${e}`).join("\n") +
        "\n";
      console.error(msg);
      throw new Error(msg);
    }
  }

  if (
    !isBuildPhase &&
    ((parsed.BOOTSTRAP_ADMIN_EMAIL && !parsed.BOOTSTRAP_ADMIN_PASSWORD) ||
      (!parsed.BOOTSTRAP_ADMIN_EMAIL && parsed.BOOTSTRAP_ADMIN_PASSWORD))
  ) {
    const msg =
      "\n[env] BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together.\n";

    console.error(msg);
    throw new Error(msg);
  }

  // S-9 runtime guard. If a build-time placeholder somehow makes it into
  // a deployed image (e.g. NEXT_PHASE accidentally set in the runtime
  // env, or the placeholder substituted into the deployment template by
  // mistake), refuse to boot. The placeholder values pass the schema by
  // design (they're long enough and don't match the obvious-junk regex),
  // so this check is the only thing standing between the deploy and a
  // fixed shared secret in production.
  // Auto-generate METRICS_TOKEN when the operator didn't pin one. /metrics is
  // a typical scrape target on a private network, but leaving it open in a
  // shared LAN is the kind of accidental exposure that's easy to never notice.
  // We default to "always require bearer auth"; if you actively want the
  // endpoint open, set METRICS_ENABLED=false or pick your own static token.
  // Skipped during build (placeholders only) and tests (deterministic vars).
  if (
    !isBuildPhase &&
    parsed.METRICS_ENABLED &&
    !parsed.METRICS_TOKEN &&
    parsed.NODE_ENV !== "test"
  ) {
    const generated = randomBytes(24).toString("base64url"); // 32 url-safe chars
    parsed.METRICS_TOKEN = generated;
    console.log(
      `[env] METRICS_TOKEN not provided, randomly generated instead: ${generated}\n` +
        "       Scrape with: Authorization: Bearer <token>. Pin it via .env (or set\n" +
        "       METRICS_ENABLED=false to opt out of the /metrics endpoint).",
    );
  }

  const placeholderViolations = detectBuildTimePlaceholders({
    APP_SECRET_KEY: parsed.APP_SECRET_KEY,
    APP_ENCRYPTION_KEY: parsed.APP_ENCRYPTION_KEY,
    DATABASE_URL: parsed.DATABASE_URL,
    isBuildPhase,
  });
  if (placeholderViolations.length > 0) {
    const msg =
      "\n[env] Build-time placeholder values detected at runtime. " +
      "The app will not start with these values — they are fixed across " +
      "all builds and would let an attacker who recovered them forge " +
      "sessions in production.\n\n" +
      `  • Affected: ${placeholderViolations.join(", ")}\n\n` +
      "Likely cause: NEXT_PHASE=phase-production-build is still set in " +
      "the runtime environment, or the deployment didn't override these " +
      "keys with real values. Generate fresh secrets:\n" +
      "  openssl rand -base64 32   # → APP_SECRET_KEY\n" +
      "  openssl rand -base64 32   # → APP_ENCRYPTION_KEY\n";

    console.error(msg);
    throw new Error(msg);
  }

  return parsed;
}

export const env: Env = parseEnv();

// =============================================================================
// Convenience derived values
// =============================================================================

export const isProduction: boolean = env.NODE_ENV === "production";
export const isDevelopment: boolean = env.NODE_ENV === "development";
export const isTest: boolean = env.NODE_ENV === "test";

/** Hostname for cookie scoping. */
export const cookieDomain: string | undefined = env.COOKIE_DOMAIN ?? new URL(env.APP_URL).hostname;

/**
 * Whether the background PDNS poller is enabled. When false (the default),
 * AuthAdmin makes no scheduled PDNS calls and the supplementary sync-aware
 * UI surfaces (header SYNCED/DESYNCED chip, zone Sync + Statistics tabs,
 * zone-list mirror column, servers-list lag column, dashboard PDNS
 * statistics tab, drift advisories) are hidden. See `PDNS_BACKGROUND_POLLING`
 * docstring above for full feature matrix.
 */
export const pdnsBackgroundPollingEnabled: boolean = env.PDNS_BACKGROUND_POLLING === true;
