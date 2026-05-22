/**
 * lib/validators/rr-types/txt.ts
 *
 * TXT content — RFC 1035 § 3.3.14: one or more <character-string>s. Each
 * character-string is a length-prefixed octet sequence, 0–255 octets long.
 * In presentation form, character-strings are quoted ("…") and may contain
 * escape sequences (`\"`, `\\`, `\NNN` decimal triples).
 *
 * Real-world TXT values for SPF, DKIM, DMARC, and challenge tokens often
 * exceed 255 octets — RFC 7208 § 3.3 requires splitting into adjacent
 * quoted strings, which are concatenated on the wire. Most authoritative
 * servers (including PDNS) accept either the pre-split form or a single
 * very-long string and split internally. We warn on un-quoted oversize
 * input so the operator knows what we'll do.
 */

import { extractQuotedStrings, octetLength } from "@/lib/dns/txt";
import type { RRTypeValidator, RRValidationIssue } from "./types";

export const txtValidator: RRTypeValidator = {
  type: "TXT",
  label: "Text",
  description:
    'Free-form text. Wrap in double quotes; split into multiple "…" "…" strings if longer than 255 octets per chunk (RFC 1035 § 3.3.14).',
  placeholder: '"v=spf1 -all"',
  rfc: "RFC 1035",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    if (trimmed === "") {
      return {
        issues: [{ level: "error", message: "TXT content is empty." }],
        normalized: trimmed,
      };
    }

    // Two accepted shapes:
    //   1. Already-quoted character-strings: `"…" "…"`
    //   2. Bare text — we warn and auto-quote at normalize.
    if (trimmed.startsWith('"')) {
      // Walk through quoted strings and check each one's payload length.
      const strings = extractQuotedStrings(trimmed);
      if (!strings) {
        return {
          issues: [
            {
              level: "error",
              message:
                "TXT content opens with `\"` but isn't a sequence of properly quoted character-strings.",
            },
          ],
          normalized: trimmed,
        };
      }
      for (const s of strings) {
        if (octetLength(s) > 255) {
          issues.push({
            level: "warning",
            message: `One character-string is ${octetLength(s)} octets; RFC 1035 caps each at 255. Split with adjacent quoted strings (RFC 7208 § 3.3).`,
          });
          break;
        }
      }
      return { issues, normalized: trimmed };
    }

    // Bare text — auto-quote, but warn if it's longer than what fits in one
    // character-string.
    const inner = trimmed.replace(/"/g, '\\"').replace(/\\/g, "\\\\");
    if (octetLength(trimmed) > 255) {
      issues.push({
        level: "warning",
        message: `Content is ${octetLength(trimmed)} octets; RFC 1035 caps each character-string at 255. PowerDNS will split it but consider providing adjacent quoted strings explicitly.`,
      });
    } else {
      issues.push({
        level: "warning",
        message:
          "TXT content should be wrapped in double quotes. We'll quote it automatically on save.",
      });
    }
    return { issues, normalized: `"${inner}"` };
  },
};
