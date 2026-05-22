/**
 * lib/validators/rr-types/svcb.ts
 *
 * SVCB / HTTPS content — RFC 9460:
 *   `<priority> <target> [SvcParams...]`
 *
 *   - priority   : uint16. 0 = AliasMode (target is the canonical
 *                  name; SvcParams MUST be empty). ≥1 = ServiceMode
 *                  (priority sorts; ties broken arbitrarily).
 *   - target     : domain name. `.` means "the owner name itself"
 *                  (i.e. ServiceMode pointing at the same host).
 *   - SvcParams  : zero or more space-separated `key=value` (or
 *                  bare `key` for booleans like `no-default-alpn`).
 *
 * Common SvcParamKeys (IANA registry):
 *   - `alpn`            : comma-separated ALPN identifiers (h2, h3, …).
 *   - `no-default-alpn` : boolean (no value).
 *   - `port`            : uint16 port override.
 *   - `ipv4hint`        : comma-separated IPv4 hints.
 *   - `ipv6hint`        : comma-separated IPv6 hints.
 *   - `mandatory`       : comma-separated SvcParamKey names the
 *                         responder MUST understand.
 *   - `ech`             : base64 Encrypted Client Hello config.
 *   - `dohpath`         : URI template for DoH.
 *
 * HTTPS records share the SVCB wire format exactly (RFC 9460 § 7);
 * the validator exports two `RRTypeValidator` instances pointing at
 * the same `validate` function, differing only in `type` / `label`.
 *
 * The full RFC 9460 § 2.1 escape grammar (backslash-escaped chars
 * + quoted SvcParam values) isn't implemented in this first-tick
 * sketch — the validator handles simple `key=value` shapes that
 * cover ~all real-world records and warns rather than errors on
 * unrecognized SvcParamKeys.
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

/** Known SvcParamKeys with their value-shape. */
type ParamValueShape = "comma-list" | "uint16" | "boolean" | "base64" | "string";
const KNOWN_PARAMS: Record<string, ParamValueShape> = {
  alpn: "comma-list",
  "no-default-alpn": "boolean",
  port: "uint16",
  ipv4hint: "comma-list",
  ipv6hint: "comma-list",
  mandatory: "comma-list",
  ech: "base64",
  dohpath: "string",
};

function validateImpl(content: string) {
  const issues: RRValidationIssue[] = [];
  const trimmed = content.trim();

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    return {
      issues: [
        {
          level: "error" as const,
          message: "SVCB/HTTPS content needs at least `<priority> <target>` (RFC 9460).",
        },
      ],
      normalized: trimmed,
    };
  }
  const [priorityStr, target, ...params] = tokens as [string, string, ...string[]];

  // priority: uint16
  let priority: number | null = null;
  if (!/^\d+$/.test(priorityStr)) {
    issues.push({
      level: "error",
      message: `Priority "${priorityStr}" is not a non-negative integer.`,
    });
  } else {
    priority = Number(priorityStr);
    if (priority > 65535) {
      issues.push({
        level: "error",
        message: "Priority must be 0–65535 (16-bit unsigned).",
      });
      priority = null;
    }
  }

  // AliasMode (priority 0) MUST NOT carry SvcParams per RFC 9460 § 2.4.2.
  if (priority === 0 && params.length > 0) {
    issues.push({
      level: "error",
      message:
        "AliasMode (priority 0) must not carry SvcParams (RFC 9460 § 2.4.2). Drop the params or switch to ServiceMode (priority ≥ 1).",
    });
  }

  // target: any non-empty token. `.` is legal (means "owner name
  // itself"). Skip strict hostname validation — PDNS will reject
  // truly broken names on save.
  if (target.length === 0) {
    issues.push({
      level: "error",
      message: "Target is empty.",
    });
  }

  // Per-SvcParam checks. Track seen keys to flag duplicates
  // (RFC 9460 § 2.2 — each key appears at most once).
  const seen = new Set<string>();
  for (const param of params) {
    const eqIdx = param.indexOf("=");
    const key = (eqIdx >= 0 ? param.slice(0, eqIdx) : param).toLowerCase();
    const value = eqIdx >= 0 ? param.slice(eqIdx + 1) : null;

    if (key.length === 0) {
      issues.push({
        level: "error",
        message: `Empty SvcParam key in "${param}".`,
      });
      continue;
    }

    if (seen.has(key)) {
      issues.push({
        level: "error",
        message: `SvcParam "${key}" appears more than once (RFC 9460 § 2.2 forbids duplicates).`,
      });
    }
    seen.add(key);

    const shape = KNOWN_PARAMS[key];
    if (!shape) {
      issues.push({
        level: "warning",
        message: `SvcParam "${key}" is not in the common IANA set (alpn, port, ipv4hint, ipv6hint, no-default-alpn, mandatory, ech, dohpath). Verify the spelling.`,
      });
      continue;
    }

    // Strip surrounding double-quotes — RFC 9460 § 2.1 allows
    // quoting for values with spaces. Crude but covers the
    // common case.
    const unquoted =
      value !== null && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

    switch (shape) {
      case "boolean":
        if (value !== null) {
          issues.push({
            level: "warning",
            message: `"${key}" is a boolean SvcParam and shouldn't carry a value.`,
          });
        }
        break;
      case "uint16":
        if (unquoted === null || unquoted.length === 0) {
          issues.push({
            level: "error",
            message: `"${key}" requires a uint16 value.`,
          });
        } else if (!/^\d+$/.test(unquoted) || Number(unquoted) > 65535) {
          issues.push({
            level: "error",
            message: `"${key}=${unquoted}" must be a uint16 (0–65535).`,
          });
        }
        break;
      case "comma-list":
        if (unquoted === null || unquoted.length === 0) {
          issues.push({
            level: "error",
            message: `"${key}" requires a comma-separated list value.`,
          });
        }
        // Don't validate individual list items (IP shapes etc.) —
        // covering ALPN strings + IP addresses uniformly would
        // be its own per-key sub-validator. Future tick.
        break;
      case "base64":
        if (unquoted === null || !/^[A-Za-z0-9+/]+=*$/.test(unquoted)) {
          issues.push({
            level: "warning",
            message: `"${key}" should be a base64 value (got "${unquoted ?? ""}").`,
          });
        }
        break;
      case "string":
        if (unquoted === null || unquoted.length === 0) {
          issues.push({
            level: "error",
            message: `"${key}" requires a string value.`,
          });
        }
        break;
    }
  }

  return {
    issues,
    normalized: trimmed,
  };
}

export const svcbValidator: RRTypeValidator = {
  type: "SVCB",
  label: "Service Binding (SVCB)",
  description:
    "priority target [key=value ...] — RFC 9460. Generic service binding; HTTPS is the same wire format with HTTPS-specific defaults.",
  placeholder: "1 . alpn=h2,h3 port=443",
  rfc: "RFC 9460",
  validate: (content) => validateImpl(content),
};

export const httpsValidator: RRTypeValidator = {
  type: "HTTPS",
  label: "HTTPS Service Binding",
  description:
    "priority target [key=value ...] — RFC 9460. HTTPS profile of SVCB; used for HTTP/3 advertisement and Encrypted Client Hello.",
  placeholder: "1 . alpn=h2,h3 ipv4hint=192.0.2.1",
  rfc: "RFC 9460 § 7",
  validate: (content) => validateImpl(content),
};
