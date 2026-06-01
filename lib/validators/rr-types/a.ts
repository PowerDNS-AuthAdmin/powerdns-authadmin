/**
 * lib/validators/rr-types/a.ts
 *
 * IPv4 address content for `A` records.
 *
 * RFC 1035 § 3.4.1: A RDATA is a 32-bit IP address. The presentation form is
 * dotted-decimal, four octets each in 0–255.
 *
 * Warnings:
 *   - 0.0.0.0 - legal but rarely an A-record's intended value.
 *   - 127.0.0.0/8 - loopback range.
 *   - 169.254.0.0/16 - link-local.
 *   - 224.0.0.0/4 - multicast.
 *   - 240.0.0.0/4 - reserved.
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export const aValidator: RRTypeValidator = {
  type: "A",
  label: "IPv4 address",
  description: "Dotted-decimal IPv4 address (RFC 1035 § 3.4.1).",
  placeholder: "192.0.2.1",
  rfc: "RFC 1035",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    if (!IPV4_RE.test(trimmed)) {
      return {
        issues: [
          {
            level: "error",
            message:
              "Not a valid IPv4 address. Expected dotted-decimal with four octets (e.g. 192.0.2.1).",
          },
        ],
        normalized: trimmed,
      };
    }

    const octets = trimmed.split(".").map(Number);
    for (const oct of octets) {
      if (oct < 0 || oct > 255 || !Number.isInteger(oct)) {
        return {
          issues: [
            {
              level: "error",
              message: `Octet ${oct} is out of range. Each octet must be 0–255.`,
            },
          ],
          normalized: trimmed,
        };
      }
    }

    // Range warnings - all RFC-legal but operationally surprising for an A.
    const [a, b] = octets as [number, number, number, number];
    if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) {
      issues.push({
        level: "warning",
        message: "0.0.0.0 - legal but unusual as a published A-record value.",
      });
    } else if (a === 127) {
      issues.push({
        level: "warning",
        message:
          "127.0.0.0/8 is loopback; publishing it in DNS exposes a localhost-only address to the world.",
      });
    } else if (a === 169 && b === 254) {
      issues.push({
        level: "warning",
        message: "169.254.0.0/16 is link-local - not routable beyond a single L2 segment.",
      });
    } else if (a >= 224 && a <= 239) {
      issues.push({
        level: "warning",
        message: "224.0.0.0/4 is multicast - uncommon as an A-record value.",
      });
    } else if (a >= 240) {
      issues.push({
        level: "warning",
        message: "240.0.0.0/4 is reserved (RFC 1112) - not a routable address.",
      });
    }

    return {
      issues,
      normalized: octets.join("."),
    };
  },
};
