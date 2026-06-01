/**
 * lib/validators/rr-types/naptr.ts
 *
 * NAPTR (Naming Authority Pointer) content - RFC 3403:
 *   `<order> <preference> "<flags>" "<services>" "<regexp>" <replacement>`
 *
 *   - order      : uint16 - lower processed first.
 *   - preference : uint16 - tiebreaker within the same order.
 *   - flags      : quoted ASCII chars (0–256 octets per RFC). Typical
 *                  letters: S (SRV lookup follows), A (A/AAAA lookup
 *                  follows), U (URI in regexp output), P (protocol-
 *                  specific terminal). Empty `""` is legal - means
 *                  the regexp must be applied for further lookup.
 *   - services   : quoted ASCII, typically a protocol identifier
 *                  with optional resolution-service tokens
 *                  ("E2U+sip", "SIP+D2U", etc per RFC 3404). Empty
 *                  is legal.
 *   - regexp     : quoted string. Either empty (`""`) - meaning
 *                  "use replacement" - or a `!pattern!replacement
 *                  !flags` form (any delimiter; bang shown is the
 *                  common one).
 *   - replacement: domain name, FQDN with trailing dot, or `.` to
 *                  indicate "no replacement; use regexp."
 *
 * NAPTR records are uncommon today (peaked with ENUM telephony
 * routing); this validator catches structural mistakes for the
 * cases that do show up - DDDS / S-NAPTR / U-NAPTR configurations.
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

/** Per RFC 3404, common NAPTR flag letters. Case-insensitive in
 * the spec but conventionally uppercase. */
const KNOWN_FLAGS = new Set(["S", "A", "U", "P"]);

export const naptrValidator: RRTypeValidator = {
  type: "NAPTR",
  label: "Naming Authority Pointer",
  description:
    'order preference "flags" "services" "regexp" replacement - RFC 3403/3404. Common for ENUM/DDDS lookups.',
  placeholder: '100 10 "S" "SIP+D2U" "" _sip._udp.example.com.',
  rfc: "RFC 3403 + RFC 3404",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    // Tokenize: respect double-quoted strings (flags/services/regexp
    // each contain whitespace). The grammar is:
    //   uint  uint  "string"  "string"  "string"  domain
    // No escaping inside quoted strings is defined by RFC 3403;
    // we treat backslash as literal and read up to the next `"`.
    const tokens = tokenizeNaptr(trimmed);
    if (tokens === null) {
      return {
        issues: [
          {
            level: "error",
            message:
              'NAPTR content failed to tokenize. Expected six parts: `<order> <preference> "<flags>" "<services>" "<regexp>" <replacement>` (RFC 3403).',
          },
        ],
        normalized: trimmed,
      };
    }
    if (tokens.length !== 6) {
      return {
        issues: [
          {
            level: "error",
            message: `NAPTR content needs exactly 6 parts; got ${tokens.length}.`,
          },
        ],
        normalized: trimmed,
      };
    }
    const [orderStr, prefStr, flagsToken, servicesToken, regexpToken, replacement] =
      tokens as unknown as readonly [string, string, string, string, string, string];

    // order: uint16
    if (!/^\d+$/.test(orderStr)) {
      issues.push({
        level: "error",
        message: `Order "${orderStr}" is not a non-negative integer.`,
      });
    } else {
      const order = Number(orderStr);
      if (order < 0 || order > 65535) {
        issues.push({
          level: "error",
          message: "Order must be 0–65535 (16-bit unsigned).",
        });
      }
    }

    // preference: uint16
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

    // flags: quoted, typically a single letter from the known set.
    const flagsInner = stripQuotes(flagsToken);
    if (flagsInner === null) {
      issues.push({
        level: "error",
        message: 'Flags must be a double-quoted string (e.g. "S" or "").',
      });
    } else {
      if (flagsInner.length > 0) {
        // Each character should be ASCII; spec doesn't strictly
        // restrict, but warn on multi-char flag values + unknown
        // letters (operators almost always set a single
        // canonical letter).
        if (flagsInner.length > 1) {
          issues.push({
            level: "warning",
            message: `Flags "${flagsInner}" is longer than one character; almost all NAPTR deployments use a single flag letter.`,
          });
        }
        const upper = flagsInner.toUpperCase();
        for (const ch of upper) {
          if (!KNOWN_FLAGS.has(ch)) {
            issues.push({
              level: "warning",
              message: `Flag "${ch}" is not in the common set {S, A, U, P} (RFC 3404). Verify against your DDDS/ENUM profile.`,
            });
            break; // one warning per record is enough
          }
        }
      }
    }

    // services: quoted, free-form.
    if (stripQuotes(servicesToken) === null) {
      issues.push({
        level: "error",
        message: 'Services must be a double-quoted string (e.g. "SIP+D2U" or "").',
      });
    }

    // regexp: quoted; either empty or `<delim>pattern<delim>repl<delim>flags`.
    const regexpInner = stripQuotes(regexpToken);
    if (regexpInner === null) {
      issues.push({
        level: "error",
        message: 'Regexp must be a double-quoted string (e.g. "" or "!^.*$!sip:user@example!").',
      });
    } else if (regexpInner.length > 0) {
      // Must start with a delimiter and contain exactly three
      // delimited fields (pattern / replacement / flags). The
      // canonical delimiter is `!` but RFC 3403 allows any char.
      const delim = regexpInner[0]!;
      const parts = regexpInner.split(delim);
      // For "!a!b!c" split gives ["", "a", "b", "c"] (length 4).
      // For "!a!b!" split gives ["", "a", "b", ""] (length 4) - flags empty.
      if (parts.length !== 4) {
        issues.push({
          level: "error",
          message: `Regexp must have three delimited parts (pattern/replacement/flags) using the leading delimiter "${delim}". Got ${parts.length - 1} parts.`,
        });
      }
    }

    // replacement: either `.` (no replacement) OR a domain name.
    // RFC 3403 says it must be a fully-qualified domain name when
    // not `.`. We warn on missing trailing dot rather than error -
    // operators sometimes load names without it and PDNS
    // canonicalizes on save.
    if (replacement !== "." && !replacement.endsWith(".")) {
      issues.push({
        level: "warning",
        message: `Replacement "${replacement}" should be fully-qualified with a trailing dot (or "." to mean no replacement).`,
      });
    }
    // Mutual-exclusivity check: regexp empty XOR replacement is `.`
    // (RFC 3403 § 4.1). Both empty is illegal - the record would
    // resolve to nothing.
    const regexpEmpty = regexpInner === "";
    const replacementEmpty = replacement === ".";
    if (regexpEmpty && replacementEmpty) {
      issues.push({
        level: "error",
        message:
          "Regexp and replacement cannot both be empty/dot - the record must point somewhere (RFC 3403 § 4.1).",
      });
    }
    if (!regexpEmpty && !replacementEmpty) {
      issues.push({
        level: "warning",
        message:
          "When regexp is non-empty, replacement should be `.` (RFC 3403 § 4.1 - regexp takes precedence). Verify your DDDS profile if both are set deliberately.",
      });
    }

    return {
      issues,
      normalized: trimmed,
    };
  },
};

/**
 * Tokenize NAPTR content into 6 fields, respecting double-quoted
 * strings. Returns null when the input has unbalanced quotes.
 */
function tokenizeNaptr(input: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    // Skip leading whitespace.
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    if (input[i] === '"') {
      // Quoted token: consume up to the matching close quote.
      let end = i + 1;
      while (end < input.length && input[end] !== '"') end++;
      if (end >= input.length) return null; // unterminated quote
      tokens.push(input.slice(i, end + 1));
      i = end + 1;
    } else {
      // Unquoted token: up to next whitespace.
      let end = i;
      while (end < input.length && !/\s/.test(input[end]!)) end++;
      tokens.push(input.slice(i, end));
      i = end;
    }
  }
  return tokens;
}

/** Strip surrounding double quotes; return null if not a properly-
 * quoted string. */
function stripQuotes(token: string): string | null {
  if (token.length < 2) return null;
  if (!token.startsWith('"') || !token.endsWith('"')) return null;
  return token.slice(1, -1);
}
