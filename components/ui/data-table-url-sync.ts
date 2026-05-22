/**
 * components/ui/data-table-url-sync.ts
 *
 * Pure helpers for the DataTable's URL-state plumbing. Extracted from
 * the component (T-102) once the writer-side helper graduated from
 * one consumer (T-100 sort) to two (T-101 sort + pageSize). Lives in
 * a .ts file rather than the .tsx so it's importable from anywhere
 * without dragging the React surface, and so a `.test.ts` can run
 * alongside without needing a JSDOM environment.
 *
 * Format choices (kept stable so URLs in operator bookmarks survive):
 *   - Sort: `col.dir[,col.dir...]` — multi-column comma-separated.
 *     `col` is the column id, `dir` is `asc` or `desc`. Unknown
 *     directions drop silently (graceful for renamed columns).
 *   - Page size: a positive integer that MUST appear in the
 *     component's allowed options. Out-of-set values are ignored.
 */

import type { SortingState } from "@tanstack/react-table";

/** Parse `?sort=col.asc,col2.desc` into a SortingState. Unknown shapes drop silently. */
export function parseSortParam(value: string | null): SortingState {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => {
      const [id, dir] = entry.split(".");
      if (!id || (dir !== "asc" && dir !== "desc")) return null;
      return { id, desc: dir === "desc" };
    })
    .filter((s): s is { id: string; desc: boolean } => s !== null);
}

/** Serialize a SortingState back to the URL shape, or empty when no sort. */
export function serializeSortParam(sort: SortingState): string {
  return sort.map((s) => `${s.id}.${s.desc ? "desc" : "asc"}`).join(",");
}

/**
 * Parse `?pageSize=N` to a positive integer that's in the allowed
 * options set. Returns null for anything else — the caller falls
 * back to the `pageSize` prop default. Strict membership check
 * prevents URL-driven row counts that would surprise the user (a
 * link with `?pageSize=9999` shouldn't blow up the DOM).
 */
export function parsePageSizeParam(
  value: string | null,
  allowed: readonly number[],
): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return allowed.includes(n) ? n : null;
}
