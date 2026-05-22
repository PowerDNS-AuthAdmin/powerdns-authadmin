/**
 * lib/validators/rr-types/dname.ts
 *
 * DNAME content — RFC 6672: a single fully-qualified domain name
 * that redirects an entire subtree to a different one. For example,
 * `example.com DNAME example.net` causes `foo.example.com` to
 * resolve as `foo.example.net`.
 *
 * Differences from CNAME worth surfacing to operators:
 *   - DNAME IS allowed at the zone apex (unlike CNAME per RFC 1034
 *     § 3.6.2).
 *   - DNAME and CNAME at the same name are forbidden (RFC 6672
 *     § 2.4). The editor enforces that at the RRset level.
 *   - A DNAME cannot have descendant records below it in the same
 *     zone (the DNAME owns the subtree). The editor surfaces this
 *     at the zone level.
 *
 * Warnings the content validator emits:
 *   - Target looks like an IP literal (DNAME points to a *name*,
 *     RFC 1912 § 2.4 applies the same way it does to CNAME).
 *   - Trailing dot missing (we normalize but warn so the operator
 *     notices the canonical form).
 */

import { validateHostname } from "./hostname";
import type { RRTypeValidator, RRValidationIssue } from "./types";

const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}\.?$/;
const IPV6_LITERAL = /^[0-9a-fA-F:]+\.?$/;

export const dnameValidator: RRTypeValidator = {
  type: "DNAME",
  label: "Delegation name",
  description: "Fully-qualified target that this name's whole subtree redirects to (RFC 6672).",
  placeholder: "example.net.",
  rfc: "RFC 6672",
  validate(content: string) {
    const trimmed = content.trim();
    const issues: RRValidationIssue[] = [];

    if (IPV4_LITERAL.test(trimmed) || (trimmed.includes(":") && IPV6_LITERAL.test(trimmed))) {
      issues.push({
        level: "warning",
        message:
          "Looks like an IP address. DNAME RDATA must be a name, not an address (RFC 1912 § 2.4). DNAME redirects a subtree to another name; addresses go in A/AAAA records.",
      });
    }

    const result = validateHostname(trimmed);
    return {
      issues: [...issues, ...result.issues],
      normalized: result.normalized,
    };
  },
};
