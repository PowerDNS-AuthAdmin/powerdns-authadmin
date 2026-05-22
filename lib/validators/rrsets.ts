/**
 * lib/validators/rrsets.ts
 *
 * Input shapes for the zone-record editor. PDNS is the authority for
 * per-RR-type content validity (A → IPv4, MX → priority+host, etc.); the
 * per-type helpers in `lib/validators/rr-types/` give the client early
 * feedback. This boundary's job is to keep *structurally hostile* input out
 * of the PDNS request body and the logs/audit: no control characters in
 * record content, and a constrained charset on record names (no CRLF /
 * whitespace / control-byte injection).
 */

import "server-only";
import { z } from "zod";
import { ttlSchema } from "./common";

const RR_TYPE_PATTERN = /^[A-Z0-9]{1,12}$/;

// Control bytes (C0 + DEL) never appear in DNS presentation-format content;
// rejecting them blocks log/response-splitting and audit-poisoning via a
// record value that reaches the PDNS PATCH body verbatim.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Record names are FQDNs (or relative labels): letters, digits, dot, hyphen,
// underscore (_dmarc, _sip._tcp), wildcard `*`, and `/` for RFC 2317
// classless reverse delegation. Anything else (whitespace, quotes, control
// bytes) is rejected before it can reach the PDNS API path or the audit log.
const NAME_PATTERN = /^[A-Za-z0-9._\-*/]+$/;

const nameSchema = z
  .string()
  .min(1, "Name is required.")
  .max(255, "Name is too long.")
  .refine((value) => NAME_PATTERN.test(value), "Name contains invalid characters.");

const recordSchema = z.object({
  content: z
    .string()
    .min(1, "Record content cannot be empty.")
    .max(65535, "Record content is unexpectedly long.")
    .refine((value) => !CONTROL_CHARS.test(value), "Records cannot contain control characters."),
  disabled: z.boolean().optional(),
});

/**
 * Per-change optimistic-concurrency token (ADR 0010). When the
 * client sends `expected`, the server compares the live PDNS rrset's
 * hash against this value and returns 409 on mismatch. Absence
 * preserves the legacy last-write-wins behavior.
 *
 * Shape: 16 hex chars matching the `rrsetHash` output. Operators
 * never type this; the editor populates it from the loaded rrset.
 */
const expectedHashSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{16}$/, "Expected hash must be 16 lowercase hex characters."),
});

const upsertChangeSchema = z.object({
  kind: z.literal("upsert"),
  name: nameSchema,
  type: z
    .string()
    .min(1, "Type is required.")
    .transform((value) => value.toUpperCase())
    .refine(
      (value) => RR_TYPE_PATTERN.test(value),
      "Type must be 1–12 uppercase alphanumerics (e.g. A, AAAA, MX).",
    ),
  ttl: ttlSchema,
  records: z.array(recordSchema).min(1, "Provide at least one record."),
  /**
   * Rrset-level comment. PDNS stores comments as a bag on the rrset
   * (not per-record). Send an empty string to clear; omit to leave
   * existing comments untouched. The route maps the string into PDNS'
   * `{ content, account, modified_at }` shape.
   */
  comment: z.string().max(2048).optional(),
  expected: expectedHashSchema.optional(),
});

const deleteChangeSchema = z.object({
  kind: z.literal("delete"),
  name: nameSchema,
  type: z
    .string()
    .min(1)
    .transform((value) => value.toUpperCase()),
  expected: expectedHashSchema.optional(),
});

export const rrsetChangeSchema = z.discriminatedUnion("kind", [
  upsertChangeSchema,
  deleteChangeSchema,
]);

export type RRsetChange = z.infer<typeof rrsetChangeSchema>;

export const patchRRsetsSchema = z.object({
  serverSlug: z.string().min(1),
  changes: z.array(rrsetChangeSchema).min(1, "At least one change is required."),
});

export type PatchRRsetsInput = z.infer<typeof patchRRsetsSchema>;
