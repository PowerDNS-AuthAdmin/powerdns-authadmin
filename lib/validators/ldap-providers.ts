/**
 * lib/validators/ldap-providers.ts
 *
 * Zod schemas for the LDAP providers admin form (ADR-0020). The bind
 * password is required at create-time, then optional on update: omitting
 * the field keeps the existing encrypted value, providing a new one
 * rotates it.
 *
 * URL safety is the security-critical bit. We refuse plain `ldap://`
 * unless EITHER `LDAP_ALLOW_INSECURE_PORT_389=true` (env-level
 * homelab opt-in) OR the row's `start_tls: true` upgrades the
 * connection after connect (RFC 4511 § 4.14). We also refuse the
 * redundant `start_tls + ldaps://` pair — the implicit-TLS port
 * already speaks TLS and most servers reject StartTLS on it.
 */

import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { slugSchema } from "./common";

const SERVER_URL_REGEX = /^(ldaps:\/\/|ldap:\/\/)[^\s]+$/i;

/**
 * URL validator. Refuses an `ldap://` URL unless EITHER the env-level
 * opt-in is on OR `start_tls` is true for this row. The two states are
 * coordinated via a top-level `.superRefine` since the StartTLS bit
 * lives on a sibling field.
 */
const serverUrlSchema = z
  .string()
  .min(1, "Server URL is required.")
  .max(500, "Server URL is too long.")
  .regex(SERVER_URL_REGEX, "Server URL must start with ldap:// or ldaps://.");

const dnSchema = z
  .string()
  .min(1)
  .max(1000)
  // The DN syntax is RFC 4514. Don't fully parse here — operators paste
  // values straight from AD/OpenLDAP and small variations (e.g. trailing
  // space, escaped commas) are common. The bind itself is the real
  // validator. We do strip whitespace at the seams because clipboard
  // paste reliably appends a newline that AD then rejects with a
  // "syntax error" indistinguishable from a wrong DN.
  .transform((s) => s.trim());

/**
 * RFC 4515 filter, with a `{{username}}` placeholder. We don't parse
 * the filter — escapes and nesting are too much for a Zod string — but
 * we DO require the placeholder so an operator can't accidentally save
 * a filter that returns every user in the directory.
 */
const userSearchFilterSchema = z
  .string()
  .min(3, "User search filter is required.")
  .max(2000, "Filter is too long.")
  .refine((s) => s.includes("{{username}}"), {
    message: "Filter must contain the {{username}} placeholder — see hint below.",
  })
  // Cheap guard against an unbalanced filter saving and then exploding
  // at sign-in time. Both AD and OpenLDAP reject mismatched parens
  // with a 16 / 32 result code that looks like a transport error.
  .refine(
    (s) => {
      const open = (s.match(/\(/g) ?? []).length;
      const close = (s.match(/\)/g) ?? []).length;
      return open === close;
    },
    { message: "Filter parentheses are unbalanced." },
  );

const groupSearchFilterSchema = z
  .string()
  .min(3)
  .max(2000)
  // The group filter is optional; the userDn placeholder is similarly
  // required when the filter IS set, otherwise the second-search path
  // would silently match every group.
  .refine((s) => s.includes("{{userDn}}"), {
    message: "Group filter must contain the {{userDn}} placeholder.",
  })
  .refine((s) => (s.match(/\(/g) ?? []).length === (s.match(/\)/g) ?? []).length, {
    message: "Group filter parentheses are unbalanced.",
  });

const attrNameSchema = z
  .string()
  .min(1)
  .max(64)
  // LDAP attribute names are LDAP-Display-Name per RFC 4512 § 2.5 — a
  // letter followed by letters, digits, hyphens, and underscores. The
  // operator-paste path produces no other shapes.
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Attribute name must be a valid LDAP display name.");

/**
 * Per-provider email-domain allow-list. Null = no restriction (LDAP
 * has no env-level default to inherit from); empty array = same thing,
 * but explicit. Non-empty array = exact list for this provider.
 */
const allowedEmailDomainsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(253)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
        "Each entry must be a bare domain (lowercase, no '@').",
      ),
  )
  .max(64, "At most 64 domains.")
  .nullable();

const groupMappingSchema = z
  .object({
    /** Exact group value to match — for AD `memberOf` this is the DN of
     *  the group, for OpenLDAP overlay the cn=… etc. Case-sensitive. */
    group: z.string().min(1).max(1000),
    roleSlug: z.string().min(1).max(64),
    scopeType: z.enum(["global", "team", "zone", "server"]),
    scopeId: z.string().min(1).max(255).nullable(),
  })
  .refine((m) => (m.scopeType === "global" ? m.scopeId === null : m.scopeId !== null), {
    message: "scopeId must be null for global scope and non-null for team/zone/server scope.",
  });

const groupMappingsSchema = z.array(groupMappingSchema).max(200).nullable();

/**
 * PEM CA certificate. Optional; when present, the LDAP TLS handshake
 * trusts this CA on top of (or instead of) the system roots. We accept
 * one or several concatenated PEM blocks. Size cap is generous because
 * AD CA bundles regularly include a chain of three or four certs.
 */
const tlsCaCertSchema = z
  .string()
  .min(1)
  .max(64 * 1024, "CA certificate is too large.")
  .refine(
    (s) => s.includes("-----BEGIN CERTIFICATE-----") && s.includes("-----END CERTIFICATE-----"),
    { message: "Expected one or more PEM CA certificates (BEGIN/END CERTIFICATE blocks)." },
  )
  .nullable();

/**
 * Apply the cross-field URL safety rules. Pulled out so the create + update
 * schemas can both call it from their `.superRefine` without duplication.
 */
function applyUrlSafety(
  serverUrl: string | undefined,
  startTls: boolean | undefined,
  ctx: z.RefinementCtx,
): void {
  if (serverUrl === undefined) return;
  const isLdaps = /^ldaps:\/\//i.test(serverUrl);
  const isLdap = /^ldap:\/\//i.test(serverUrl);

  if (isLdaps && startTls === true) {
    ctx.addIssue({
      code: "custom",
      path: ["startTls"],
      message:
        "StartTLS is redundant on ldaps:// URLs — the implicit-TLS port already speaks TLS. Pick one.",
    });
  }
  if (isLdap && startTls !== true && !env.LDAP_ALLOW_INSECURE_PORT_389) {
    ctx.addIssue({
      code: "custom",
      path: ["serverUrl"],
      message:
        "Plain ldap:// is refused unless the row enables StartTLS (recommended) or LDAP_ALLOW_INSECURE_PORT_389=true is set in the environment.",
    });
  }
}

export const createLdapProviderSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1, "Name is required.").max(120),
    serverUrl: serverUrlSchema,
    startTls: z.boolean().default(false),
    bindDn: dnSchema,
    // Trimmed same as the OIDC client secret — clipboard whitespace is the
    // most common reason a known-good password silently mismatches the DC.
    bindPassword: z
      .string()
      .min(1, "Bind password is required.")
      .max(2048)
      .transform((s) => s.trim()),
    userSearchBase: dnSchema,
    userSearchFilter: userSearchFilterSchema.default(
      "(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))",
    ),
    groupSearchBase: dnSchema.optional(),
    groupSearchFilter: groupSearchFilterSchema.optional(),
    groupAttr: attrNameSchema.default("memberOf"),
    claimEmail: attrNameSchema.default("mail"),
    claimName: attrNameSchema.default("displayName"),
    tlsCaCert: tlsCaCertSchema.optional(),
    enabled: z.boolean().default(true),
    allowedEmailDomains: allowedEmailDomainsSchema.optional(),
    groupMappings: groupMappingsSchema.optional(),
  })
  .superRefine((val, ctx) => applyUrlSafety(val.serverUrl, val.startTls, ctx))
  .superRefine((val, ctx) => {
    if (val.groupSearchBase !== undefined && val.groupSearchFilter === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["groupSearchFilter"],
        message: "Group search base is set, but no group search filter is configured.",
      });
    }
    if (val.groupSearchFilter !== undefined && val.groupSearchBase === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["groupSearchBase"],
        message: "Group search filter is set, but no group search base is configured.",
      });
    }
  });

export type CreateLdapProviderInput = z.infer<typeof createLdapProviderSchema>;

export const updateLdapProviderSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    serverUrl: serverUrlSchema.optional(),
    startTls: z.boolean().optional(),
    bindDn: dnSchema.optional(),
    /** Omit to keep the existing password; provide a new one to rotate. */
    bindPassword: z
      .string()
      .min(1)
      .max(2048)
      .transform((s) => s.trim())
      .optional(),
    userSearchBase: dnSchema.optional(),
    userSearchFilter: userSearchFilterSchema.optional(),
    /** null = clear, omit = leave unchanged, string = set. */
    groupSearchBase: z.union([dnSchema, z.null()]).optional(),
    groupSearchFilter: z.union([groupSearchFilterSchema, z.null()]).optional(),
    groupAttr: attrNameSchema.optional(),
    claimEmail: attrNameSchema.optional(),
    claimName: attrNameSchema.optional(),
    /** null = clear pin, string = set, omit = leave unchanged. */
    tlsCaCert: tlsCaCertSchema.optional(),
    enabled: z.boolean().optional(),
    allowedEmailDomains: allowedEmailDomainsSchema.optional(),
    groupMappings: groupMappingsSchema.optional(),
  })
  .superRefine((val, ctx) => applyUrlSafety(val.serverUrl, val.startTls, ctx))
  .superRefine((val, ctx) => {
    // Coordinated group-search pair: when one is set non-null, the other
    // must too (or both must be cleared together). Cleared-on-one-side
    // is the operator's "stop using the second search" intent.
    const baseSet = val.groupSearchBase !== undefined && val.groupSearchBase !== null;
    const filterSet = val.groupSearchFilter !== undefined && val.groupSearchFilter !== null;
    const baseCleared = val.groupSearchBase === null;
    const filterCleared = val.groupSearchFilter === null;
    if (baseSet && filterCleared) {
      ctx.addIssue({
        code: "custom",
        path: ["groupSearchBase"],
        message: "Clearing the group filter while setting a group base is inconsistent.",
      });
    }
    if (filterSet && baseCleared) {
      ctx.addIssue({
        code: "custom",
        path: ["groupSearchFilter"],
        message: "Clearing the group base while setting a group filter is inconsistent.",
      });
    }
  });

export type UpdateLdapProviderInput = z.infer<typeof updateLdapProviderSchema>;

/** Sign-in request body. Same shape as the local /api/auth/login. */
export const ldapLoginSchema = z.object({
  username: z.string().min(1, "Username is required.").max(320),
  password: z.string().min(1, "Password is required.").max(1024),
  captchaToken: z.string().max(4096).optional(),
});

export type LdapLoginInput = z.infer<typeof ldapLoginSchema>;
