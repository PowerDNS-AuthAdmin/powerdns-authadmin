/**
 * lib/validators/saml-providers.ts
 *
 * Zod schemas for the SAML providers admin form. Mirrors the OIDC validator
 * (`lib/validators/oidc-providers.ts`) so the route + form code can stay
 * structurally parallel.
 *
 * PEM material is validated lazily - we accept anything that looks like a
 * PEM block (BEGIN/END markers + base64 body). The deep cryptographic check
 * runs at first use (`@node-saml/node-saml` rejects malformed keys when the
 * SAML class is constructed), which is the right place to surface "this key
 * is corrupt" since the same path runs on every login.
 */

import "server-only";
import { z } from "zod";
import { slugSchema } from "./common";

/**
 * Loose PEM block validator. Accepts an arbitrary BEGIN/END pair so a future
 * IdP can ship `BEGIN RSA PRIVATE KEY` vs `BEGIN PRIVATE KEY`; the real check
 * is at first sign-in, not here.
 */
const pemSchema = z
  .string()
  .min(1, "PEM block is required.")
  .max(64 * 1024, "PEM block is too large.")
  .refine(
    (v) => /-----BEGIN [^-]+-----[\s\S]+-----END [^-]+-----/.test(v.trim()),
    "Value must be a PEM block (-----BEGIN ...----- ... -----END ...-----).",
  );

const optionalPemSchema = pemSchema.optional().nullable();

const urlSchema = z
  .string()
  .url("Must be a full URL including scheme (https://...).")
  .refine(
    (v) => v.startsWith("http://") || v.startsWith("https://"),
    "URL must use http:// or https://.",
  );

const attributeNameSchema = z
  .string()
  .min(1, "Attribute name is required.")
  .max(200, "Attribute name is too long.");

/** XML-DSig digest / signature algorithm. */
const signatureAlgorithmSchema = z.enum(["sha1", "sha256", "sha512"]);

/** A SAML NameID format URI. We accept the common ones plus any urn:... shape
 *  for forward-compat with custom formats. */
const nameIdFormatSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) => v.startsWith("urn:") || v.startsWith("http"),
    "NameID format must be a URN (e.g. urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress).",
  );

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
    group: z.string().min(1).max(500),
    roleSlug: z.string().min(1).max(64),
    scopeType: z.enum(["global", "team", "zone", "server"]),
    scopeId: z.string().min(1).max(255).nullable(),
  })
  .refine((m) => (m.scopeType === "global" ? m.scopeId === null : m.scopeId !== null), {
    message: "scopeId must be null for global scope and non-null for team/zone/server scope.",
  });

const groupMappingsSchema = z.array(groupMappingSchema).max(200).nullable();

export const createSamlProviderSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1, "Name is required.").max(120),

  idpEntityId: z.string().min(1, "IdP entityID is required.").max(500),
  idpSsoUrl: urlSchema,
  idpSloUrl: urlSchema.optional().nullable(),
  idpSigningCert: pemSchema,

  /** SP signing keypair (PEM). Required at create time - operators generate
   *  one with `openssl req -x509 -newkey rsa:2048 -keyout sp.key -out sp.crt
   *  -nodes -days 1825 -subj "/CN=<slug>"` and paste it in. */
  spSigningKey: pemSchema,
  spSigningCert: pemSchema,

  spEncryptionKey: optionalPemSchema,
  spEncryptionCert: optionalPemSchema,

  requireSignedResponse: z.boolean().default(true),
  requireEncryptedAssertion: z.boolean().default(false),
  signatureAlgorithm: signatureAlgorithmSchema.default("sha256"),
  nameIdFormat: nameIdFormatSchema.default(
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  ),

  claimEmail: attributeNameSchema.default("email"),
  claimName: attributeNameSchema.default("name"),
  claimGroups: attributeNameSchema.default("groups"),

  enabled: z.boolean().default(true),
  allowedEmailDomains: allowedEmailDomainsSchema.optional(),
  groupMappings: groupMappingsSchema.optional(),
});

export type CreateSamlProviderInput = z.infer<typeof createSamlProviderSchema>;

export const updateSamlProviderSchema = z.object({
  name: z.string().min(1).max(120).optional(),

  idpEntityId: z.string().min(1).max(500).optional(),
  idpSsoUrl: urlSchema.optional(),
  // `null` clears the SLO endpoint; omit to leave unchanged.
  idpSloUrl: z.union([urlSchema, z.null()]).optional(),
  idpSigningCert: pemSchema.optional(),

  /** Rotate the SP signing keypair. Both must be sent together; sending just
   *  one is rejected at the route boundary. */
  spSigningKey: pemSchema.optional(),
  spSigningCert: pemSchema.optional(),

  /** Three-state on each: undefined = unchanged, null = clear (no encryption
   *  support), PEM = set. Both members must move together. */
  spEncryptionKey: z.union([pemSchema, z.null()]).optional(),
  spEncryptionCert: z.union([pemSchema, z.null()]).optional(),

  requireSignedResponse: z.boolean().optional(),
  requireEncryptedAssertion: z.boolean().optional(),
  signatureAlgorithm: signatureAlgorithmSchema.optional(),
  nameIdFormat: nameIdFormatSchema.optional(),

  claimEmail: attributeNameSchema.optional(),
  claimName: attributeNameSchema.optional(),
  claimGroups: attributeNameSchema.optional(),

  enabled: z.boolean().optional(),
  allowedEmailDomains: allowedEmailDomainsSchema.optional(),
  groupMappings: groupMappingsSchema.optional(),
});

export type UpdateSamlProviderInput = z.infer<typeof updateSamlProviderSchema>;
