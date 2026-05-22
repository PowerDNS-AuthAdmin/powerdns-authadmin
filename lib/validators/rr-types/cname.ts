/**
 * lib/validators/rr-types/cname.ts
 *
 * CNAME content — RFC 1035 § 3.3.1: a single domain name pointing to the
 * canonical name. Combined with the CNAME-only-at-apex prohibition, this is
 * one of DNS's most frequently mis-used record types.
 *
 * Warnings the validator emits:
 *   - Content looks like an IP literal — CNAME points to a *name*, not an
 *     address. RFC 1912 § 2.4.
 *   - Content equals "@" or the zone apex — circular reference.
 *   - Content equals the RRset's own name — circular CNAME.
 *
 * Apex-CNAME (CNAME on the zone apex) is also forbidden per RFC 1034 § 3.6.2
 * but that's a property of the RRset's name, not the content; the editor
 * handles it at the form level.
 */

import { validateHostname } from "./hostname";
import type { RRTypeValidator, RRValidationIssue } from "./types";

const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}\.?$/;
const IPV6_LITERAL = /^[0-9a-fA-F:]+\.?$/;

export const cnameValidator: RRTypeValidator = {
  type: "CNAME",
  label: "Canonical name",
  description: "Fully-qualified target name the alias resolves to (RFC 1035 § 3.3.1).",
  placeholder: "target.example.com.",
  rfc: "RFC 1035",
  validate(content: string) {
    const trimmed = content.trim();
    const issues: RRValidationIssue[] = [];

    if (IPV4_LITERAL.test(trimmed) || (trimmed.includes(":") && IPV6_LITERAL.test(trimmed))) {
      issues.push({
        level: "warning",
        message:
          "Looks like an IP address. CNAME RDATA must be a name, not an address (RFC 1912 § 2.4). Use A or AAAA if you wanted an address.",
      });
    }

    const result = validateHostname(trimmed);
    return {
      issues: [...issues, ...result.issues],
      normalized: result.normalized,
    };
  },
};
