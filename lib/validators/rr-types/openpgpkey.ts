/**
 * lib/validators/rr-types/openpgpkey.ts
 *
 * OPENPGPKEY content — RFC 7929: a single base64-encoded OpenPGP
 * transferable public key (the "key packet"). No delimiters, no
 * sub-fields — the entire RDATA is one base64 blob.
 *
 * Owner-name semantics live at the RRset level (per RFC 7929 § 3,
 * the local-part of an email is SHA-256-hashed + truncated to 56
 * hex chars + `._openpgpkey.<domain>`). This validator only checks
 * the content blob.
 *
 * Validation surface:
 *   - Hard-error on empty content (the record points nowhere).
 *   - Hard-error on non-base64 characters after whitespace strip.
 *   - Hard-error on base64 length not divisible by 4 (the padding
 *     rules of RFC 4648 § 4).
 *   - Soft-warn when the decoded length is suspiciously short
 *     (a real PGP public key packet is typically >300 bytes; <50
 *     bytes is almost certainly wrong).
 *
 * Common operator workflow: copy the output of
 * `gpg --export <key-id> | base64 -w0` directly into the editor.
 * The validator strips whitespace and the base64 alphabet check
 * tolerates the common `-w0` (no wrap) and default (76-col wrap)
 * outputs equally.
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

/** RFC 4648 base64 alphabet (standard, not URL-safe). */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const openpgpkeyValidator: RRTypeValidator = {
  type: "OPENPGPKEY",
  label: "OpenPGP public key",
  description:
    "Base64-encoded OpenPGP transferable public key (RFC 7929). Typical workflow: `gpg --export <key-id> | base64 -w0`.",
  placeholder: "mQENBF...long base64...AAA==",
  rfc: "RFC 7929",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const compact = content.replace(/\s+/g, "");

    if (compact.length === 0) {
      return {
        issues: [
          {
            level: "error",
            message: "OPENPGPKEY content is empty.",
          },
        ],
        normalized: compact,
      };
    }

    if (!BASE64_RE.test(compact)) {
      issues.push({
        level: "error",
        message:
          "OPENPGPKEY content must be base64 (A-Z, a-z, 0-9, +, /; trailing `=` padding). URL-safe base64 (`-` / `_`) is not accepted; re-encode.",
      });
    } else if (compact.length % 4 !== 0) {
      // RFC 4648 § 4: base64 output length is always a multiple of 4
      // (padded with `=`). A non-multiple-of-4 length means missing
      // or stripped padding — likely a copy-paste truncation.
      issues.push({
        level: "error",
        message: `Base64 length (${compact.length}) is not a multiple of 4. Padding '=' is likely missing or the value was truncated.`,
      });
    } else {
      // Decoded length: each 4 base64 chars = 3 bytes, minus the
      // padding count. Used for the sanity warning below.
      const padCount = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
      const decodedLen = (compact.length / 4) * 3 - padCount;
      if (decodedLen < 50) {
        issues.push({
          level: "warning",
          message: `Decoded key is only ~${decodedLen} bytes. A real OpenPGP transferable public key is typically several hundred bytes; this looks truncated or wrong.`,
        });
      }
    }

    // Normalize to whitespace-stripped form so PDNS stores a
    // consistent representation regardless of how the operator
    // pasted it.
    return {
      issues,
      normalized: compact,
    };
  },
};
