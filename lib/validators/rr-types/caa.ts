/**
 * lib/validators/rr-types/caa.ts
 *
 * CAA content - RFC 8659: `<flags> <tag> <value>` where:
 *   - flags  : 8-bit unsigned (only bit 7, the "Issuer Critical" flag, is
 *              defined as of RFC 8659 § 4.1).
 *   - tag    : 1–15 octets, [a-z0-9] only (case-insensitive matching but
 *              presentation is canonically lowercase per § 4.1.1).
 *   - value  : quoted character-string. Permitted tags as of RFC 8659:
 *              issue, issuewild, iodef, contactemail, contactphone.
 *              ACME-related: accounturi, validationmethods (RFC 8657).
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

const KNOWN_TAGS = new Set([
  "issue",
  "issuewild",
  "iodef",
  "contactemail",
  "contactphone",
  "accounturi",
  "validationmethods",
]);

export const caaValidator: RRTypeValidator = {
  type: "CAA",
  label: "Certification Authority Authorization",
  description: 'flags tag "value" - e.g. `0 issue "letsencrypt.org"` (RFC 8659).',
  placeholder: '0 issue "letsencrypt.org"',
  rfc: "RFC 8659",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    // Permissive split: flags, tag, then "everything else" as the value (so
    // values with spaces stay intact).
    const match = /^(\S+)\s+(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) {
      return {
        issues: [
          {
            level: "error",
            message: 'CAA content needs three parts: `<flags> <tag> "<value>"` (RFC 8659).',
          },
        ],
        normalized: trimmed,
      };
    }
    const [, flagsStr, rawTag, rawValue] = match as unknown as [string, string, string, string];

    if (!/^\d+$/.test(flagsStr)) {
      issues.push({
        level: "error",
        message: `Flags "${flagsStr}" is not a non-negative integer.`,
      });
    } else {
      const flags = Number(flagsStr);
      if (flags < 0 || flags > 255) {
        issues.push({
          level: "error",
          message: "Flags must be 0–255 (8-bit unsigned).",
        });
      } else if (flags & 0x7f) {
        issues.push({
          level: "warning",
          message:
            "Only bit 7 (`128` - Issuer Critical) is defined in RFC 8659; other flag bits are reserved.",
        });
      }
    }

    const tag = rawTag.toLowerCase();
    if (!/^[a-z0-9]{1,15}$/.test(tag)) {
      issues.push({
        level: "error",
        message: "Tag must be 1–15 lowercase ASCII letters or digits (RFC 8659 § 4.1.1).",
      });
    } else if (!KNOWN_TAGS.has(tag)) {
      issues.push({
        level: "warning",
        message: `Tag "${tag}" is not in the IANA registry of common CAA tags. Override if it's a custom or recently-registered tag.`,
      });
    }

    const value = rawValue.trim();
    if (!(value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
      issues.push({
        level: "warning",
        message: "CAA value should be a double-quoted character-string. We'll quote it on save.",
      });
    }

    // Only pass the value through verbatim when it is already a balanced
    // quoted string (starts AND ends with '"', length ≥ 2). A leading-only
    // quote (e.g. `"letsencrypt.org`) is unbalanced - re-quoting it prevents
    // emitting malformed wire data.
    const isBalancedQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
    // Escape `\` before `"` (RFC 1035 § 5.1 character-string rules): doing it
    // the other way doubles the backslash the quote pass just inserted, and
    // leaving `\` unescaped emits malformed wire data for a value that contains
    // one. Both meta-characters must be escaped.
    const escapeForQuoting = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const normalizedValue = isBalancedQuoted ? value : `"${escapeForQuoting(value)}"`;
    return {
      issues,
      normalized: `${Number(flagsStr) || 0} ${tag} ${normalizedValue}`,
    };
  },
};
