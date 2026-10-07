/**
 * components/ui/select-menu-keys.ts
 *
 * Pure keyboard helpers for `<SelectMenu>`: type-ahead matching, arrow
 * movement and the filter used by the searchable variant. Kept free of
 * React so the behaviour is unit-testable (the vitest suite runs in a
 * bare Node environment - no DOM).
 *
 * Type-ahead follows the native `<select>` rules operators already have in
 * their fingers:
 *
 *   - Typing a prefix ("TL") jumps to the first option whose label starts
 *     with it, searching forward from the active option and wrapping.
 *   - Repeating the same first letter ("T", "T", "T") cycles through every
 *     option that starts with that letter (TXT → TLSA → TXT …) instead of
 *     treating "TT" as a prefix nobody has.
 *   - Matching is case-insensitive and ignores leading whitespace.
 */

export interface TypeaheadOption {
  label: string;
  description?: string;
}

/** Keystrokes closer together than this extend the same type-ahead buffer. */
export const TYPEAHEAD_TIMEOUT_MS = 600;

/**
 * Resolve which option a type-ahead buffer lands on. Returns `-1` when
 * nothing matches so the caller can leave the highlight where it is.
 *
 * `activeIndex` is the currently highlighted option (`-1` for none). The
 * search always starts *after* it so repeated presses advance.
 */
export function findTypeaheadIndex(
  options: readonly TypeaheadOption[],
  buffer: string,
  activeIndex: number,
): number {
  const needle = buffer.trimStart().toLowerCase();
  if (needle === "" || options.length === 0) return -1;

  const repeatedLetter = needle.length > 1 && needle.split("").every((c) => c === needle[0]);
  // "TT" means "next option starting with T", not "an option starting with TT".
  const prefix = repeatedLetter ? needle[0]! : needle;

  const startsWith = (idx: number) =>
    options[idx]!.label.trimStart().toLowerCase().startsWith(prefix);

  // When the buffer grew into a longer prefix ("T" → "TL"), the operator is
  // refining the current pick, so the current option may itself be the
  // answer: start the scan ON it. A single letter or a repeated letter is a
  // "give me the next one" gesture: start AFTER it.
  const refining = !repeatedLetter && needle.length > 1;
  const first = refining ? Math.max(activeIndex, 0) : activeIndex + 1;
  for (let step = 0; step < options.length; step++) {
    const idx = (first + step) % options.length;
    if (startsWith(idx)) return idx;
  }
  return -1;
}

/**
 * Append a key to the type-ahead buffer, resetting it when the previous
 * keystroke is older than `TYPEAHEAD_TIMEOUT_MS`.
 */
export function extendTypeaheadBuffer(
  previous: { text: string; at: number },
  key: string,
  now: number,
): { text: string; at: number } {
  const stale = now - previous.at > TYPEAHEAD_TIMEOUT_MS;
  return { text: (stale ? "" : previous.text) + key, at: now };
}

/** A key that should feed type-ahead: one printable character, no modifier. */
export function isTypeaheadKey(
  key: string,
  modifiers: { ctrl: boolean; meta: boolean; alt: boolean },
) {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return false;
  // Space is handled as "select" on a closed trigger, so it never reaches here
  // unless the buffer is already non-empty (multi-word labels).
  return key.length === 1 && key !== " ";
}

/**
 * Move the highlight by `delta`, clamped to the list (native selects don't
 * wrap on arrow keys, and neither should we - the operator at the bottom of
 * the list pressing Down expects to stay put, not jump to the top).
 */
export function moveIndex(current: number, delta: number, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/**
 * Filter + rank options for the searchable variant. Ranking keeps the
 * result order predictable while the operator types:
 *
 *   1. label starts with the query        (A, AAAA for "a")
 *   2. label contains the query           (CAA for "a" - after the above)
 *   3. description contains the query     (A for "ipv4")
 *
 * Within a tier the original order is preserved, so a curated list stays in
 * its curated order. Returns indexes into `options`.
 */
export function filterOptionIndexes(options: readonly TypeaheadOption[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (q === "") return options.map((_, i) => i);
  const tiers: [number[], number[], number[]] = [[], [], []];
  options.forEach((o, i) => {
    const label = o.label.toLowerCase();
    if (label.startsWith(q)) tiers[0].push(i);
    else if (label.includes(q)) tiers[1].push(i);
    else if (o.description?.toLowerCase().includes(q)) tiers[2].push(i);
  });
  return [...tiers[0], ...tiers[1], ...tiers[2]];
}
