/**
 * Pretty-print arbitrary JSON to an array of lines suitable for feeding
 * into the `BareDiff` component. Null / undefined snapshots become an
 * empty array (caller hides the column or renders an empty diff).
 *
 * Lives outside the `"use client"` BareDiff module so React Server
 * Components can call it directly when assembling props.
 */
export function jsonToDiffLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    if (typeof value === "string") return [value];
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return [String(value)];
    }
    return ["<unserializable value>"];
  }
}
