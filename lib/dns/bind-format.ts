/**
 * lib/dns/bind-format.ts
 *
 * Render an RRset list as BIND-style zonefile text, matching what `pdnsutil
 * list-zone` would emit. Used by the editor's "Review changes" modal to give
 * the operator a familiar, copy-pasteable view of the zone before and after
 * a pending edit.
 *
 * Output format (one record per line, tab-separated columns):
 *
 *   $ORIGIN .
 *   example.com.    3600    IN      A       192.0.2.1
 *   example.com.    3600    IN      NS      ns1.example.com.
 *   www.example.com.        3600    IN      A       192.0.2.1
 *
 * Notes / deliberate choices:
 *   - We emit `$ORIGIN .` so names are always absolute - no relative-label
 *     ambiguity for diffing. That matches how `pdnsutil list-zone` works.
 *   - Disabled records are prefixed with "; DISABLED " so they're parseable
 *     and visually distinct in the diff.
 *   - Records within an RRset are sorted by content so the diff is stable
 *     against PDNS' arbitrary ordering. Same reason RRsets are sorted by
 *     (name, type) up at the call site.
 *
 * No tokenization here - that's `tokenizeBindLine` below, separate so the
 * formatter stays pure / testable.
 */

import "client-only";

export interface BindRRset {
  /** Fully-qualified name with trailing dot. */
  name: string;
  /** Uppercase RR type (A, AAAA, MX, …). */
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
  /**
   * Optional rrset-level comment. Surfaces in the BIND-style diff as a
   * `; comment: …` line keyed by name+type so the operator sees comment
   * edits - not just record value edits - in the Review-changes dialog.
   */
  comment?: string;
}

/**
 * Build the BIND zonefile text for a set of RRsets. Pure: same input always
 * yields the same output (records sorted inside each RRset; RRsets the
 * caller already sorted - we don't re-sort to preserve DNS-hierarchy order).
 */
export function rrsetsToBindZonefile(rrsets: readonly BindRRset[]): string {
  const lines: string[] = ["$ORIGIN ."];
  for (const rrset of rrsets) {
    const sorted = [...rrset.records].sort((a, b) => a.content.localeCompare(b.content));
    for (const record of sorted) {
      const prefix = record.disabled ? "; DISABLED " : "";
      lines.push(`${prefix}${rrset.name}\t${rrset.ttl}\tIN\t${rrset.type}\t${record.content}`);
    }
    const commentText = rrset.comment?.trim() ?? "";
    if (commentText !== "") {
      lines.push(`; ${rrset.name} ${rrset.type} comment: ${commentText}`);
    }
  }
  // Trailing newline matters: diffLines treats the final line as "X" without
  // it and "X\n" once another line follows. Otherwise identical content at
  // the end of a file looks "modified" when lines are appended after it.
  // Always terminate every line including the last.
  return lines.join("\n") + "\n";
}

// =============================================================================
// Tokenizer for syntax highlighting in the diff view
// =============================================================================

export type BindTokenKind =
  | "directive" // $ORIGIN, $TTL, etc.
  | "comment" // ; everything after
  | "disabled" // the "; DISABLED " sentinel we emit
  | "name" // owner name
  | "ttl" // numeric TTL
  | "class" // IN, CH, …
  | "type" // A, AAAA, MX, …
  | "rdata" // everything after the type
  | "whitespace"
  | "empty";

export interface BindToken {
  kind: BindTokenKind;
  text: string;
}

const DIRECTIVE_PATTERN = /^\$[A-Z]+\b/;
const RR_CLASSES = new Set(["IN", "CH", "HS"]);
/**
 * Tokenize a single line of BIND zonefile text. Returns tokens in original
 * order, including whitespace tokens so the caller can render with `<pre>`-
 * style fidelity.
 *
 * Heuristic - not a full RFC 1035 parser. Good enough for highlighting our
 * own emitted format; pathological hand-written zonefiles (parenthesized
 * multi-line records, $INCLUDE chains) aren't a concern because we render
 * what `rrsetsToBindZonefile` produced.
 */
export function tokenizeBindLine(line: string): BindToken[] {
  if (line === "") return [{ kind: "empty", text: "" }];

  // Comment lines we emit specifically for disabled records.
  if (line.startsWith("; DISABLED ")) {
    const sentinel = "; DISABLED ";
    const rest = line.slice(sentinel.length);
    return [{ kind: "disabled", text: sentinel }, ...tokenizeBindLine(rest)];
  }

  // Generic comment.
  if (line.startsWith(";")) {
    return [{ kind: "comment", text: line }];
  }

  // Directive line ($ORIGIN, $TTL, …).
  if (DIRECTIVE_PATTERN.test(line)) {
    const directiveMatch = DIRECTIVE_PATTERN.exec(line)!;
    const directive = directiveMatch[0];
    const rest = line.slice(directive.length);
    const out: BindToken[] = [{ kind: "directive", text: directive }];
    if (rest.length > 0) out.push({ kind: "rdata", text: rest });
    return out;
  }

  // Record line: <name> <ttl> <class> <type> <rdata>
  // Split on runs of whitespace, preserving the whitespace so the rendered
  // line keeps tab-spacing.
  const tokens: BindToken[] = [];
  const parts = splitPreservingWhitespace(line);
  // Index over the non-whitespace parts so we can assign roles.
  let semanticIndex = 0;
  for (const part of parts) {
    if (/^\s+$/.test(part.text)) {
      tokens.push({ kind: "whitespace", text: part.text });
      continue;
    }
    let kind: BindTokenKind;
    if (semanticIndex === 0) {
      kind = "name";
    } else if (semanticIndex === 1 && /^\d+$/.test(part.text)) {
      kind = "ttl";
    } else if (semanticIndex === 2 && RR_CLASSES.has(part.text)) {
      kind = "class";
    } else if (semanticIndex === 3) {
      kind = "type";
    } else {
      kind = "rdata";
    }
    tokens.push({ kind, text: part.text });
    semanticIndex++;
  }
  return tokens;
}

interface RawPart {
  text: string;
}

function splitPreservingWhitespace(input: string): RawPart[] {
  const parts: RawPart[] = [];
  let buf = "";
  let inWs = /^\s/.test(input.charAt(0));
  for (const ch of input) {
    const isWs = /\s/.test(ch);
    if (isWs !== inWs) {
      if (buf.length > 0) parts.push({ text: buf });
      buf = ch;
      inWs = isWs;
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push({ text: buf });
  return parts;
}
