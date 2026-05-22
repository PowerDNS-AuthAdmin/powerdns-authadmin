/**
 * lib/validators/rr-types/mx.ts
 *
 * MX content — RFC 1035 § 3.3.9: `<preference> <exchange>`, where
 * preference is a 16-bit unsigned integer and exchange is a domain name.
 *
 * RFC 7505 (Null MX): a single MX of `0 .` says "this name accepts no mail".
 * Recognized and accepted without an exchange-name warning.
 */

import { validateHostname } from "./hostname";
import type { RRTypeValidator, RRValidationIssue } from "./types";

export const mxValidator: RRTypeValidator = {
  type: "MX",
  label: "Mail exchange",
  description:
    "Preference (0–65535) and exchange hostname, e.g. `10 mail.example.com.` (RFC 1035 § 3.3.9, RFC 7505 for `0 .`).",
  placeholder: "10 mail.example.com.",
  rfc: "RFC 1035",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    const parts = trimmed.split(/\s+/);
    if (parts.length !== 2) {
      return {
        issues: [
          {
            level: "error",
            message:
              "MX content must be exactly two whitespace-separated tokens: preference and exchange.",
          },
        ],
        normalized: trimmed,
      };
    }

    const [prefStr, exchange] = parts as [string, string];

    if (!/^\d+$/.test(prefStr)) {
      issues.push({
        level: "error",
        message: `Preference "${prefStr}" is not a non-negative integer.`,
      });
    } else {
      const pref = Number(prefStr);
      if (pref < 0 || pref > 65535) {
        issues.push({
          level: "error",
          message: "Preference must be 0–65535 (16-bit unsigned).",
        });
      }
    }

    // RFC 7505: Null MX is `0 .` — a literal dot exchange. Accept without
    // running the hostname validator (which would emit warnings).
    if (exchange === ".") {
      if (prefStr !== "0") {
        issues.push({
          level: "warning",
          message: 'Null MX should have preference 0 (RFC 7505 § 3): "0 ." is the canonical form.',
        });
      }
      return { issues, normalized: `${prefStr} .` };
    }

    const host = validateHostname(exchange);
    issues.push(...host.issues);

    return {
      issues,
      normalized: `${Number(prefStr)} ${host.normalized}`,
    };
  },
};
