/**
 * lib/validators/rr-types/hostname.ts
 *
 * Shared validators for DNS names (labels). Used by every type whose content
 * references a hostname: CNAME, NS, PTR, MX (exchange), SRV (target).
 *
 * RFCs:
 *   - RFC 1035 § 2.3.1: label syntax - letter | digit | hyphen, no leading
 *     or trailing hyphen, 1–63 octets per label, 255 octets total.
 *   - RFC 1123 § 2.1: relaxes 1035 to allow digits as the first character of
 *     a label (so "10.example.com" is legal).
 *   - RFC 2181 § 11: DNS labels can technically be any binary octet - but
 *     "preferred name syntax" remains 1035/1123 for compatibility. We warn,
 *     not error, on out-of-preferred-syntax labels so the operator can still
 *     override for non-host use cases (e.g. underscored SRV targets).
 *   - RFC 4592: wildcard labels (`*.`) - accepted at first label only.
 *   - RFC 5891: IDNA / punycode - we accept ASCII-only output (i.e.
 *     `xn--…`). Unicode at the boundary should be encoded by the caller.
 */

import type { RRValidationIssue, RRValidationResult } from "./types";

/** Preferred-syntax label per RFC 1035 + 1123 (no leading/trailing hyphen). */
const PREFERRED_LABEL_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

/** Any-octet-mostly label, used for warning rather than error. */
const RELAXED_LABEL_RE = /^[A-Za-z0-9_-]{1,63}$/;

interface HostnameOptions {
  /** Whether `*` is allowed as the first label (wildcards). Default false. */
  allowWildcard?: boolean;
  /**
   * Whether the name must be fully qualified (trailing dot). If true, missing
   * trailing dot is auto-added at normalize time AND a warning is added.
   */
  requireTrailingDot?: boolean;
  /** Whether underscored labels are allowed (SRV, DKIM, DMARC). */
  allowUnderscore?: boolean;
}

/**
 * Validate a hostname per the preferred DNS name syntax. Emits errors for
 * structural violations (overlong labels, empty, illegal characters in
 * strict mode) and warnings for stylistic concerns (missing trailing dot,
 * unusual characters). The returned `normalized` form is lowercased with a
 * single trailing dot.
 */
export function validateHostname(raw: string, opts: HostnameOptions = {}): RRValidationResult {
  const issues: RRValidationIssue[] = [];
  const trimmed = raw.trim();

  if (trimmed === "") {
    return {
      issues: [{ level: "error", message: "Name is required." }],
      normalized: raw,
    };
  }

  if (trimmed.length > 254) {
    issues.push({
      level: "error",
      message: `Name is ${trimmed.length} octets; RFC 1035 caps a fully-qualified name at 255 octets including the root label.`,
    });
  }

  const hadTrailingDot = trimmed.endsWith(".");
  const withoutDot = hadTrailingDot ? trimmed.slice(0, -1) : trimmed;
  const labels = withoutDot.split(".");

  if (!hadTrailingDot) {
    issues.push({
      level: opts.requireTrailingDot ? "warning" : "warning",
      message:
        "Missing trailing dot - added at save time. Hostnames in zone content should be fully qualified (RFC 1035 § 5.1).",
    });
  }

  labels.forEach((label, idx) => {
    if (label === "") {
      issues.push({
        level: "error",
        message: `Empty label at position ${idx + 1} (consecutive dots).`,
      });
      return;
    }
    if (label.length > 63) {
      issues.push({
        level: "error",
        message: `Label "${label}" is ${label.length} octets; RFC 1035 limits a label to 63 octets.`,
      });
    }
    // Wildcard handling: `*` only legal as the first label.
    if (label === "*") {
      if (!opts.allowWildcard) {
        issues.push({
          level: "warning",
          message:
            "Wildcard label encountered - accepted by RFC 4592 but unusual for this record type.",
        });
      } else if (idx !== 0) {
        issues.push({
          level: "error",
          message: "Wildcard `*` is only legal as the leftmost label (RFC 4592 § 2.1).",
        });
      }
      return;
    }
    // Underscored labels: RFC 1035 doesn't allow, but RFC 2782 (SRV), 6376
    // (DKIM), 7489 (DMARC) all require underscored "service" labels.
    if (label.includes("_") && !opts.allowUnderscore) {
      issues.push({
        level: "warning",
        message: `Label "${label}" uses underscore - only the "preferred name syntax" of RFC 1035 + 1123 is letters / digits / hyphens. Override if this is a service label (DKIM, DMARC, SRV target, etc.).`,
      });
    }
    if (!PREFERRED_LABEL_RE.test(label)) {
      if (RELAXED_LABEL_RE.test(label)) {
        // Already warned about underscore above; suppress duplicates here.
        if (!label.includes("_")) {
          issues.push({
            level: "warning",
            message: `Label "${label}" has leading or trailing hyphen - outside preferred syntax (RFC 1123 § 2.1).`,
          });
        }
      } else {
        issues.push({
          level: "error",
          message: `Label "${label}" contains characters outside [A-Za-z0-9-]. RFC 1035 preferred name syntax forbids them.`,
        });
      }
    }
  });

  const normalized = `${withoutDot.toLowerCase()}.`;
  return { issues, normalized };
}

/**
 * Slimmer variant for the *name* of an RRset (not the content). Used when
 * the editor accepts `www`, `@`, or `www.example.com.` as the RRset's owner.
 * Zone-relative names are stamped against the zone in the caller, so this
 * accepts both fully-qualified and bare-label input.
 */
export function validateRRsetName(raw: string): RRValidationResult {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "@") {
    return { issues: [], normalized: "@" };
  }
  return validateHostname(trimmed);
}
