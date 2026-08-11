/**
 * PowerDNS LUA content (PowerDNS-specific, not an IETF RR type):
 *   `<query-type> "<Lua snippet>" ["<continued snippet>" ...]`
 *
 * PowerDNS evaluates an ordinary snippet as an expression (as though it were
 * the argument to `return`). Full statements start with `;`; a `LUA` selector
 * is also allowed for configuration records. We deliberately do not attempt
 * to parse Lua here. Doing that incompletely would reject valid PowerDNS Lua,
 * while successful parsing would still say nothing about runtime behaviour.
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

interface QuotedSnippet {
  chunks: string[];
  error?: string;
}

export const luaValidator: RRTypeValidator = {
  type: "LUA",
  label: "PowerDNS Lua record",
  description:
    "PowerDNS query type followed by a quoted Lua expression, e.g. `A \"ifportup(443, {'192.0.2.1', '192.0.2.2'})\"`. Only use trusted code.",
  placeholder: "A \"ifportup(443, {'192.0.2.1', '192.0.2.2'})\"",
  rfc: "PowerDNS Lua Records (PowerDNS-specific)",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    if (trimmed === "") {
      return {
        issues: [{ level: "error", message: "LUA content is empty." }],
        normalized: trimmed,
      };
    }

    if (/\r|\n/.test(trimmed)) {
      return {
        issues: [
          {
            level: "error",
            message:
              "LUA content cannot contain literal newlines. Keep it on one line or encode the newline inside the quoted snippet.",
          },
        ],
        normalized: trimmed,
      };
    }

    const match = /^(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) {
      return {
        issues: [
          {
            level: "error",
            message:
              'LUA content needs a query type and quoted snippet: `<query-type> "<Lua expression>"`.',
          },
        ],
        normalized: trimmed,
      };
    }

    const [, rawQueryType, rawSnippet] = match as unknown as [string, string, string];
    const queryType = rawQueryType.toUpperCase();

    // The exact set of assigned mnemonics evolves, so validate the shape
    // rather than maintaining a stale allow-list.
    const numericType = /^TYPE(\d+)$/.exec(queryType);
    if (!/^[A-Z][A-Z0-9-]*$/.test(queryType) || (queryType.startsWith("TYPE") && !numericType)) {
      issues.push({
        level: "error",
        message: `Query type "${rawQueryType}" is not a valid DNS type mnemonic.`,
      });
    } else if (numericType) {
      const typeCode = Number(numericType[1]);
      if (typeCode > 65535) {
        issues.push({
          level: "error",
          message: "Numeric query type must be TYPE0–TYPE65535.",
        });
      }
    }

    const parsed = parseQuotedSnippet(rawSnippet);
    if (parsed.error) {
      issues.push({ level: "error", message: parsed.error });
    } else {
      if (parsed.chunks.join("").length === 0) {
        issues.push({
          level: "error",
          message: "The quoted Lua snippet cannot be empty.",
        });
      }

      for (const chunk of parsed.chunks) {
        const octets = new TextEncoder().encode(chunk).length;
        if (octets > 255) {
          issues.push({
            level: "warning",
            message: `One quoted snippet segment is ${octets} octets. Split long LUA content into adjacent quoted segments of at most 255 octets so AXFR does not split the code in an unsafe place.`,
          });
          break;
        }
      }
    }

    if (trimmed.length > 65535) {
      issues.push({
        level: "error",
        message: `Content is ${trimmed.length} characters; the DNS message-size ceiling is 65535.`,
      });
    }

    return { issues, normalized: `${queryType} ${rawSnippet}` };
  },
};

/** Parse one or more adjacent DNS presentation-format quoted strings. */
function parseQuotedSnippet(input: string): QuotedSnippet {
  const chunks: string[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    if (input[i] !== '"') {
      return {
        chunks,
        error:
          'The Lua snippet must be one or more double-quoted strings; escape embedded `"` characters as `\\"`.',
      };
    }
    i++;

    let chunk = "";
    let closed = false;
    while (i < input.length) {
      const char = input[i]!;
      if (char === '"') {
        i++;
        closed = true;
        break;
      }
      if (char === "\\") {
        if (i + 1 >= input.length) {
          return { chunks, error: "The quoted Lua snippet ends with an incomplete escape." };
        }

        // RFC 1035 presentation syntax permits \DDD decimal octet escapes.
        const decimal = input.slice(i + 1, i + 4);
        if (/^\d{3}$/.test(decimal)) {
          const value = Number(decimal);
          if (value > 255) {
            return { chunks, error: `Decimal escape \\${decimal} is outside 0–255.` };
          }
          // A decimal escape represents exactly one wire octet.
          // An ASCII placeholder preserves that length for the check above.
          chunk += "x";
          i += 4;
        } else {
          chunk += input[i + 1]!;
          i += 2;
        }
        continue;
      }
      chunk += char;
      i++;
    }

    if (!closed) {
      return { chunks, error: "The Lua snippet has an unterminated double-quoted string." };
    }
    chunks.push(chunk);
  }

  return { chunks };
}
