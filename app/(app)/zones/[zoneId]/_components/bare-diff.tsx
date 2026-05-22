"use client";

/**
 * app/(app)/zones/[zoneId]/_components/bare-diff.tsx
 *
 * Two-column "Before / After" diff with character-level highlights and
 * one horizontal scroll bar per section (not per row). Layout switches
 * between side-by-side and stacked:
 *
 *   side-by-side — Before column left, After column right. Rows are
 *                  paired across columns by Jaccard similarity so the
 *                  same logical record/value sits on the same horizontal
 *                  line in both sides. Good for unordered "bags of
 *                  records" (rrset edits, metadata values).
 *
 *   stacked      — Before section on top, After section below, each
 *                  showing its lines in ORIGINAL order. Used for ordered
 *                  text snapshots where line position matters (audit-log
 *                  JSON, settings dumps). Backed by `diffLines` so a
 *                  paragraph of edits stays internally consistent
 *                  instead of being reshuffled by the similarity pairer.
 *
 * Both layouts run `diffWordsWithSpace` on paired lines to highlight the
 * actual changed tokens. Empty sides render "—" so the eye doesn't have
 * to scan for missing rows.
 */

import { diffLines, diffWordsWithSpace } from "diff";
import { type BindRRset } from "@/lib/dns/bind-format";

export function computeBindDiff(
  before: readonly BindRRset[],
  after: readonly BindRRset[],
): { removed: string[]; added: string[] } {
  const beforeLines = rrsetsToLines(before);
  const afterLines = rrsetsToLines(after);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = beforeLines.filter((l) => !afterSet.has(l)).sort();
  const added = afterLines.filter((l) => !beforeSet.has(l)).sort();
  return { removed, added };
}

function rrsetsToLines(rrsets: readonly BindRRset[]): string[] {
  const lines: string[] = [];
  for (const rr of rrsets) {
    for (const r of rr.records) {
      const prefix = r.disabled ? "; DISABLED " : "";
      lines.push(`${prefix}${rr.name}\t${rr.ttl}\tIN\t${rr.type}\t${r.content}`);
    }
    const commentText = rr.comment?.trim() ?? "";
    if (commentText !== "") {
      lines.push(`; ${rr.name} ${rr.type} comment: ${commentText}`);
    }
  }
  return lines;
}

export function BareDiff({
  removed,
  added,
  layout = "side-by-side",
}: {
  removed: readonly string[];
  added: readonly string[];
  layout?: "side-by-side" | "stacked";
}) {
  if (removed.length === 0 && added.length === 0) {
    return <p className="px-4 py-3 text-xs text-[color:var(--color-fg-muted)]">No changes.</p>;
  }

  if (layout === "stacked") return <StackedDiff removed={removed} added={added} />;
  return <SideBySideDiff removed={removed} added={added} />;
}

// =============================================================================
// Side-by-side layout (paired rows aligned across columns)
// =============================================================================

function SideBySideDiff({
  removed,
  added,
}: {
  removed: readonly string[];
  added: readonly string[];
}) {
  const pairs = pairLinesBySimilarity(removed, added);
  return (
    <div className="grid grid-cols-2 divide-x divide-[color:var(--color-border)]">
      <DiffSection title="Before">
        {pairs.map((p, i) => (
          <DiffRow
            key={`b-${i}`}
            segments={p.beforeSegments}
            present={p.beforePresent}
            kind="removed"
          />
        ))}
      </DiffSection>
      <DiffSection title="After">
        {pairs.map((p, i) => (
          <DiffRow
            key={`a-${i}`}
            segments={p.afterSegments}
            present={p.afterPresent}
            kind="added"
          />
        ))}
      </DiffSection>
    </div>
  );
}

// =============================================================================
// Stacked layout (ordered text, line-order preserved per side)
// =============================================================================

function StackedDiff({ removed, added }: { removed: readonly string[]; added: readonly string[] }) {
  const { beforeRows, afterRows } = buildStackedRows(removed, added);
  return (
    <div className="divide-y divide-[color:var(--color-border)]">
      <DiffSection title="Before">
        {beforeRows.length === 0 ? (
          <EmptyRow kind="removed" />
        ) : (
          beforeRows.map((r, i) => (
            <DiffRow
              key={`b-${i}`}
              segments={r.segments}
              present
              kind="removed"
              tinted={r.changed}
            />
          ))
        )}
      </DiffSection>
      <DiffSection title="After">
        {afterRows.length === 0 ? (
          <EmptyRow kind="added" />
        ) : (
          afterRows.map((r, i) => (
            <DiffRow key={`a-${i}`} segments={r.segments} present kind="added" tinted={r.changed} />
          ))
        )}
      </DiffSection>
    </div>
  );
}

interface StackedRow {
  segments: Segment[];
  /** Whether this line is part of the delta (gets the soft row tint). */
  changed: boolean;
}

/**
 * Order-preserving stacked diff. Joins the line arrays back to text,
 * runs the proper line-level diff (`diffLines`), then walks chunks:
 *   unchanged → render on both sides with no tint
 *   removed → before only, tinted, char-highlight if paired with the
 *             next added chunk
 *   added   → after only, tinted, char-highlight if paired with the
 *             previous removed chunk
 *
 * This preserves the natural left-to-right reading order of a JSON
 * snapshot, unlike the similarity-pairing path which reshuffles rows.
 */
function buildStackedRows(
  removed: readonly string[],
  added: readonly string[],
): { beforeRows: StackedRow[]; afterRows: StackedRow[] } {
  const beforeText = removed.join("\n");
  const afterText = added.join("\n");
  const chunks = diffLines(beforeText, afterText);

  const beforeRows: StackedRow[] = [];
  const afterRows: StackedRow[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const lines = chunkLines(c.value);
    if (!c.added && !c.removed) {
      // Unchanged context — render plain on both sides so the user sees
      // the surrounding shape (matters for JSON diffs).
      for (const line of lines) {
        beforeRows.push({ segments: [{ text: line, changed: false }], changed: false });
        afterRows.push({ segments: [{ text: line, changed: false }], changed: false });
      }
      continue;
    }
    if (c.removed && chunks[i + 1]?.added) {
      // Replacement — pair removed lines with the following added lines.
      const next = chunks[i + 1]!;
      const removedLines = chunkLines(c.value);
      const addedLines = chunkLines(next.value);
      const pairCount = Math.min(removedLines.length, addedLines.length);
      for (let k = 0; k < pairCount; k++) {
        const { beforeSegments, afterSegments } = charDiff(removedLines[k]!, addedLines[k]!);
        beforeRows.push({ segments: beforeSegments, changed: true });
        afterRows.push({ segments: afterSegments, changed: true });
      }
      for (let k = pairCount; k < removedLines.length; k++) {
        beforeRows.push({ segments: [{ text: removedLines[k]!, changed: true }], changed: true });
      }
      for (let k = pairCount; k < addedLines.length; k++) {
        afterRows.push({ segments: [{ text: addedLines[k]!, changed: true }], changed: true });
      }
      i += 1; // we consumed the next chunk
      continue;
    }
    if (c.removed) {
      for (const line of lines) {
        beforeRows.push({ segments: [{ text: line, changed: true }], changed: true });
      }
      continue;
    }
    // c.added (without a preceding removed pair)
    for (const line of lines) {
      afterRows.push({ segments: [{ text: line, changed: true }], changed: true });
    }
  }

  return { beforeRows, afterRows };
}

function chunkLines(value: string): string[] {
  // `diffLines` keeps trailing newlines on chunks — strip the final empty
  // line that splitting introduces. Empty interior lines are preserved.
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function charDiff(
  before: string,
  after: string,
): { beforeSegments: Segment[]; afterSegments: Segment[] } {
  const chunks = diffWordsWithSpace(before, after);
  const beforeSegments: Segment[] = [];
  const afterSegments: Segment[] = [];
  for (const c of chunks) {
    if (c.added) afterSegments.push({ text: c.value, changed: true });
    else if (c.removed) beforeSegments.push({ text: c.value, changed: true });
    else {
      beforeSegments.push({ text: c.value, changed: false });
      afterSegments.push({ text: c.value, changed: false });
    }
  }
  return { beforeSegments, afterSegments };
}

// =============================================================================
// Shared section + row chrome
// =============================================================================

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="border-b border-[color:var(--color-border)] px-4 py-1.5 text-[0.65rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {title}
      </div>
      {/* Container-level horizontal scroll so wide records get one scrollbar
          per section instead of one per row. `inline-block` on the row
          content keeps lines from soft-wrapping; the outer overflow handles
          horizontal overflow for everything inside. */}
      <div className="overflow-x-auto">
        <div className="min-w-full">{children}</div>
      </div>
    </div>
  );
}

interface Segment {
  text: string;
  changed: boolean;
}

interface AlignedPair {
  beforePresent: boolean;
  afterPresent: boolean;
  beforeSegments: Segment[];
  afterSegments: Segment[];
}

function DiffRow({
  segments,
  present,
  kind,
  tinted,
}: {
  segments: Segment[];
  present: boolean;
  kind: "added" | "removed";
  /** Force the row tint on for stacked-layout lines flagged as changed. */
  tinted?: boolean;
}) {
  if (!present) {
    // Placeholder for one-sided pairs: a muted dash so the row is still
    // visible and aligned with its counterpart on the other side.
    return (
      <div className="px-4 py-1 font-mono text-xs whitespace-pre text-[color:var(--color-fg-subtle)]">
        —
      </div>
    );
  }
  const showTint = tinted ?? true;
  const rowTint = showTint
    ? kind === "added"
      ? "bg-[color-mix(in_oklch,var(--color-success)_12%,transparent)]"
      : "bg-[color-mix(in_oklch,var(--color-error)_12%,transparent)]"
    : "";

  return (
    <div
      className={`px-4 py-1 font-mono text-xs whitespace-pre text-[color:var(--color-fg)] ${rowTint}`}
    >
      {segments.length === 0 ? (
        <span className="text-[color:var(--color-fg-subtle)]">—</span>
      ) : (
        segments.map((seg, i) => (
          <SegmentSpan key={i} text={seg.text} changed={seg.changed} kind={kind} />
        ))
      )}
    </div>
  );
}

function EmptyRow({ kind }: { kind: "added" | "removed" }) {
  // Stacked-layout empty-section placeholder — clearly shows the
  // operator that this side has no content (pure-create / pure-delete).
  const rowTint =
    kind === "added"
      ? "bg-[color-mix(in_oklch,var(--color-success)_12%,transparent)]"
      : "bg-[color-mix(in_oklch,var(--color-error)_12%,transparent)]";
  return (
    <div
      className={`px-4 py-1 font-mono text-xs whitespace-pre text-[color:var(--color-fg-subtle)] ${rowTint}`}
    >
      —
    </div>
  );
}

function SegmentSpan({
  text,
  changed,
  kind,
}: {
  text: string;
  changed: boolean;
  kind: "added" | "removed";
}) {
  if (!changed) return <>{text}</>;
  const tint =
    kind === "added"
      ? "bg-[color-mix(in_oklch,var(--color-success)_45%,transparent)]"
      : "bg-[color-mix(in_oklch,var(--color-error)_45%,transparent)]";
  return <span className={tint}>{text}</span>;
}

// =============================================================================
// Similarity-based pair builder (side-by-side layout)
// =============================================================================

function pairLinesBySimilarity(
  removed: readonly string[],
  added: readonly string[],
): AlignedPair[] {
  const removedRemaining = removed.map((line, idx) => ({ line, idx }));
  const addedRemaining = added.map((line, idx) => ({ line, idx }));
  const pairs: Array<{ r?: { line: string; idx: number }; a?: { line: string; idx: number } }> = [];

  while (removedRemaining.length > 0 && addedRemaining.length > 0) {
    let bestRi = -1;
    let bestAi = -1;
    let bestScore = 0;
    for (let ri = 0; ri < removedRemaining.length; ri++) {
      for (let ai = 0; ai < addedRemaining.length; ai++) {
        const r = removedRemaining[ri]!.line;
        const a = addedRemaining[ai]!.line;
        const score = similarity(r, a);
        if (score > bestScore) {
          bestScore = score;
          bestRi = ri;
          bestAi = ai;
        }
      }
    }
    if (bestScore < 0.3) break;
    pairs.push({
      r: removedRemaining.splice(bestRi, 1)[0],
      a: addedRemaining.splice(bestAi, 1)[0],
    });
  }
  for (const r of removedRemaining) pairs.push({ r });
  for (const a of addedRemaining) pairs.push({ a });

  pairs.sort((p, q) => {
    const pBoth = p.r && p.a ? 0 : 1;
    const qBoth = q.r && q.a ? 0 : 1;
    if (pBoth !== qBoth) return pBoth - qBoth;
    const pi = p.r?.idx ?? p.a?.idx ?? 0;
    const qi = q.r?.idx ?? q.a?.idx ?? 0;
    return pi - qi;
  });

  return pairs.map(({ r, a }) => {
    if (r && a) {
      const { beforeSegments, afterSegments } = charDiff(r.line, a.line);
      return {
        beforePresent: true,
        afterPresent: true,
        beforeSegments,
        afterSegments,
      };
    }
    if (r) {
      return {
        beforePresent: true,
        afterPresent: false,
        beforeSegments: [{ text: r.line, changed: true }],
        afterSegments: [],
      };
    }
    return {
      beforePresent: false,
      afterPresent: true,
      beforeSegments: [],
      afterSegments: [{ text: a!.line, changed: true }],
    };
  });
}

function similarity(a: string, b: string): number {
  const aTokens = new Set(a.split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.split(/\s+/).filter(Boolean));
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  let intersection = 0;
  for (const t of aTokens) if (bTokens.has(t)) intersection++;
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
