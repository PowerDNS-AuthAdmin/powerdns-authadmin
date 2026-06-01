/**
 * lib/validators/rr-types/uri.ts
 *
 * URI content - RFC 7553:
 *   `<priority> <weight> "<target-URI>"`
 *
 *   - priority: uint16 - lower processed first, same semantics as SRV.
 *   - weight  : uint16 - load-balancing within the same priority,
 *               same semantics as SRV § 3.
 *   - target  : double-quoted URI per RFC 3986. Empty target ("")
 *               is explicitly forbidden by RFC 7553 § 4.5.
 *
 * Typical use case: ENUM-NAPTR replaced by URI for simpler dynamic
 * service discovery (`_voice._tcp.example.com IN URI 10 1
 * "sip:info@example.com"`). Also used by DNS-SD service-binding
 * records.
 *
 * Validation surface:
 *   - Hard-error on wrong token count, non-uint16 numerics,
 *     unquoted target, empty target string.
 *   - Soft-warn when the URI has no scheme (per RFC 3986
 *     URI-reference vs URI distinction - the spec says URI, not
 *     URI-reference). Many operators paste relative URIs by
 *     habit; let them save but flag it.
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

export const uriValidator: RRTypeValidator = {
  type: "URI",
  label: "URI",
  description:
    'priority weight "target-URI" - RFC 7553. Quoted RFC 3986 URI (e.g. `10 1 "sip:info@example.com"`).',
  placeholder: '10 1 "https://example.com/path"',
  rfc: "RFC 7553",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    // Match: <num> <num> "<rest>" - the target may contain spaces
    // but is always one quoted string. Use a greedy regex anchored
    // to start + end.
    const match = /^(\S+)\s+(\S+)\s+"(.*)"$/s.exec(trimmed);
    if (!match) {
      return {
        issues: [
          {
            level: "error",
            message:
              'URI content needs three parts: `<priority> <weight> "<target>"` with the target double-quoted (RFC 7553).',
          },
        ],
        normalized: trimmed,
      };
    }
    const [, priorityStr, weightStr, target] = match as unknown as [string, string, string, string];

    // priority: uint16
    if (!/^\d+$/.test(priorityStr)) {
      issues.push({
        level: "error",
        message: `Priority "${priorityStr}" is not a non-negative integer.`,
      });
    } else if (Number(priorityStr) > 65535) {
      issues.push({
        level: "error",
        message: "Priority must be 0–65535 (16-bit unsigned).",
      });
    }

    // weight: uint16
    if (!/^\d+$/.test(weightStr)) {
      issues.push({
        level: "error",
        message: `Weight "${weightStr}" is not a non-negative integer.`,
      });
    } else if (Number(weightStr) > 65535) {
      issues.push({
        level: "error",
        message: "Weight must be 0–65535 (16-bit unsigned).",
      });
    }

    // target: non-empty + has a scheme.
    if (target.length === 0) {
      issues.push({
        level: "error",
        message: "Target URI cannot be empty (RFC 7553 § 4.5).",
      });
    } else if (!URI_HAS_SCHEME.test(target)) {
      // RFC 3986 § 3 says URI MUST have a scheme; URI-reference
      // (which allows relative) is what RFC 7553 explicitly does
      // NOT use. Soft-warn - operators often paste relative URIs
      // by habit.
      issues.push({
        level: "warning",
        message:
          "Target looks scheme-less (no `scheme:` prefix). RFC 7553 requires a full URI, not a relative URI-reference.",
      });
    }

    return {
      issues,
      normalized: trimmed,
    };
  },
};

/**
 * RFC 3986 § 3.1 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
 * followed by `:`. Used to detect the URI-vs-URI-reference
 * distinction; doesn't try to be a full URI parser.
 */
const URI_HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+\-.]*:/;
