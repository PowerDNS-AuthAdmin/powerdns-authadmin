/**
 * lib/validators/rr-types/smimea.ts
 *
 * SMIMEA (DANE for S/MIME) content - RFC 8162. The wire format is
 * **identical to TLSA**: `<usage> <selector> <matching-type>
 * <cert-data>` with the same field semantics + the same hex-length
 * rules per matching-type. RFC 8162 § 3 calls this out explicitly:
 *
 *   > The SMIMEA wire format and presentation format are the same as
 *   > for the TLSA record as described in Section 2.1 of RFC 6698.
 *
 * The semantic difference between SMIMEA and TLSA lives in the
 * RRset owner-name (SMIMEA uses
 * `<hash-of-localpart>._smimecert.<domain>` per RFC 8162 § 3) -
 * that's the editor's job at the RRset level, not content
 * validation's.
 *
 * Implementation: delegate the per-record content check to
 * `tlsaValidator.validate`. SMIMEA-specific fields (label,
 * description, placeholder, RFC citation) are overridden so the
 * editor renders the right copy.
 */

import { tlsaValidator } from "./tlsa";
import type { RRTypeValidator } from "./types";

export const smimeaValidator: RRTypeValidator = {
  type: "SMIMEA",
  label: "SMIMEA (DANE for S/MIME)",
  description:
    "usage selector matching-type cert-data (RFC 8162). Same wire format as TLSA but published under `<hash>._smimecert.<domain>`.",
  placeholder: "3 1 1 a1b2c3...64hex...",
  rfc: "RFC 8162 (wire format inherited from RFC 6698)",
  // Wrapped in an arrow rather than `validate: tlsaValidator.validate`
  // to satisfy `@typescript-eslint/unbound-method` - TLSA's validate
  // doesn't reference `this` but the rule can't prove that.
  validate: (content) => tlsaValidator.validate(content),
};
