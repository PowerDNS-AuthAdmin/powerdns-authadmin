/**
 * lib/validators/rr-types/generic.ts
 *
 * Fallback validator for RR types we don't have a specialized check for
 * (DS, DNSKEY, NSEC, HTTPS, SVCB, NAPTR, SSHFP, TLSA, …). It enforces only
 * the universal constraints: non-empty, no embedded newlines, total length
 * inside the wire-format ceiling. The operator gets a warning that they're
 * outside type-aware checking and should double-check the spec.
 */

import type { RRTypeValidator } from "./types";

export function makeGenericValidator(type: string): RRTypeValidator {
  const upper = type.toUpperCase();
  return {
    type: upper,
    label: `${upper} record`,
    description: `Free-form content. We don't have a typed validator for ${upper} yet — PowerDNS itself rejects malformed RDATA when the patch lands.`,
    placeholder: "",
    rfc: "varies",
    validate(content: string) {
      const trimmed = content.trim();
      const issues = [];
      if (trimmed === "") {
        return {
          issues: [{ level: "error" as const, message: "Content is empty." }],
          normalized: trimmed,
        };
      }
      if (trimmed.includes("\n")) {
        return {
          issues: [{ level: "error" as const, message: "Content can't contain newlines." }],
          normalized: trimmed,
        };
      }
      if (trimmed.length > 65535) {
        issues.push({
          level: "error" as const,
          message: `Content is ${trimmed.length} chars; max is 65535 (DNS message size cap, RFC 1035).`,
        });
      }
      issues.push({
        level: "warning" as const,
        message: `No type-aware validation for ${upper}. The PowerDNS backend will reject the patch if the content is malformed.`,
      });
      return { issues, normalized: trimmed };
    },
  };
}
