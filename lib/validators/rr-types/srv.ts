/**
 * lib/validators/rr-types/srv.ts
 *
 * SRV content — RFC 2782: `<priority> <weight> <port> <target>` for service
 * location. Priority, weight, and port are all 16-bit unsigned integers.
 * Target is a domain name; the special value `.` indicates "service not
 * available at this domain" (similar in spirit to Null MX).
 *
 * Note that SRV RRset *names* follow `_service._proto.name.` — the underscore
 * labels live in the name field, not in the content. The validator allows
 * underscores in the target name with a warning since it's unusual.
 */

import { validateHostname } from "./hostname";
import type { RRTypeValidator, RRValidationIssue } from "./types";

export const srvValidator: RRTypeValidator = {
  type: "SRV",
  label: "Service location",
  description: "priority weight port target — e.g. `10 5 443 service.example.com.` (RFC 2782).",
  placeholder: "10 5 443 service.example.com.",
  rfc: "RFC 2782",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    const parts = trimmed.split(/\s+/);
    if (parts.length !== 4) {
      return {
        issues: [
          {
            level: "error",
            message:
              "SRV content needs four whitespace-separated tokens: priority, weight, port, target.",
          },
        ],
        normalized: trimmed,
      };
    }

    const [prio, weight, port, target] = parts as [string, string, string, string];
    for (const [label, value] of [
      ["priority", prio],
      ["weight", weight],
      ["port", port],
    ] as const) {
      if (!/^\d+$/.test(value)) {
        issues.push({
          level: "error",
          message: `${label} "${value}" is not a non-negative integer.`,
        });
      } else {
        const n = Number(value);
        if (label === "port" && n > 65535) {
          // Port is a 16-bit field (RFC 2782); values above 65535 cannot be
          // encoded — this is a hard range violation, not just unusual usage.
          issues.push({
            level: "error",
            message: "Port must be 0–65535 (16-bit unsigned, RFC 2782).",
          });
        } else if (label === "port" && n < 1) {
          issues.push({
            level: "warning",
            message:
              "Port 0 is reserved and unusual; 1–65535 is the normal range (RFC 2782).",
          });
        } else if ((label === "priority" || label === "weight") && (n < 0 || n > 65535)) {
          issues.push({
            level: "error",
            message: `${label} must be 0–65535 (16-bit unsigned).`,
          });
        }
      }
    }

    if (target === ".") {
      return { issues, normalized: `${prio} ${weight} ${port} .` };
    }
    const host = validateHostname(target);
    issues.push(...host.issues);
    return {
      issues,
      normalized: `${Number(prio)} ${Number(weight)} ${Number(port)} ${host.normalized}`,
    };
  },
};
