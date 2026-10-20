/**
 * lib/search/fuzzy.ts
 *
 * The fuzzy matcher behind the global search palette. Pure and dependency-free
 * so it runs the same in the route handler and in unit tests.
 *
 * A query matches a text when every whitespace-separated token of the query is
 * a case-insensitive subsequence of the text ("exmp" matches "example.com").
 * The score rewards what makes a match feel right to an operator typing a
 * name: a hit at the very start, hits on word boundaries (after `.`, `-`, `_`,
 * space, `@`, `/`), runs of consecutive characters, and short texts; it
 * penalises gaps. Ranges are half-open `[start, end)` character spans of the
 * original text, merged, ready for `<mark>` highlighting.
 *
 * Each token is located with the fzf v1 approach: a forward scan finds the
 * earliest end of a match, a backward scan from there finds the latest start,
 * which yields the tightest window without a quadratic DP. A contiguous
 * substring hit is scored as well and wins when it is better, so "ample"
 * highlights one run inside "example" instead of scattered letters.
 */

export type MatchRange = readonly [start: number, end: number];

export interface FuzzyMatch {
  score: number;
  ranges: MatchRange[];
}

export interface ScoreOptions {
  /**
   * Reject a token whose matched window is wider than
   * `token.length * maxSpreadFactor + 8` characters. Long free-text fields
   * (TXT records) otherwise contain almost any short subsequence, which makes
   * every row "match" and drowns the useful hits.
   */
  maxSpreadFactor?: number;
}

const BOUNDARY_CHARS = new Set([".", "-", "_", " ", "@", "/", ":"]);

const SCORE_PER_CHAR = 16;
const BONUS_PREFIX = 32;
const BONUS_BOUNDARY = 14;
const BONUS_CONSECUTIVE = 12;
const BONUS_EXACT = 120;
const PENALTY_GAP_PER_CHAR = 1;
const MAX_GAP_PENALTY = 18;
const PENALTY_LEADING_PER_CHAR = 0.5;
const MAX_LEADING_PENALTY = 12;
const PENALTY_LENGTH_PER_CHAR = 0.15;
const MAX_LENGTH_PENALTY = 20;
const SPREAD_SLACK = 8;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return BOUNDARY_CHARS.has(text[index - 1]!);
}

/** Score one set of matched positions (ascending indexes into `text`). */
function scorePositions(text: string, positions: readonly number[]): number {
  let score = 0;
  let previous = -2;
  for (const position of positions) {
    score += SCORE_PER_CHAR;
    if (position === 0) score += BONUS_PREFIX;
    else if (isBoundary(text, position)) score += BONUS_BOUNDARY;
    if (position === previous + 1) score += BONUS_CONSECUTIVE;
    else if (previous >= 0)
      score -= Math.min(MAX_GAP_PENALTY, (position - previous - 1) * PENALTY_GAP_PER_CHAR);
    previous = position;
  }
  const first = positions[0] ?? 0;
  score -= Math.min(MAX_LEADING_PENALTY, first * PENALTY_LEADING_PER_CHAR);
  return score;
}

/** fzf-v1 style tightest subsequence window for one lowercase token. */
function subsequencePositions(lowerText: string, token: string): number[] | null {
  let ti = 0;
  let end = -1;
  for (let i = 0; i < lowerText.length; i++) {
    if (lowerText[i] === token[ti]) {
      ti++;
      if (ti === token.length) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  let start = end;
  ti = token.length - 1;
  for (let i = end; i >= 0; i--) {
    if (lowerText[i] === token[ti]) {
      ti--;
      if (ti < 0) {
        start = i;
        break;
      }
    }
  }
  const positions: number[] = [];
  ti = 0;
  for (let i = start; i <= end && ti < token.length; i++) {
    if (lowerText[i] === token[ti]) {
      positions.push(i);
      ti++;
    }
  }
  return positions;
}

/** Best contiguous occurrence of `token`: the first one on a word boundary, else the first. */
function substringPositions(text: string, lowerText: string, token: string): number[] | null {
  let first = lowerText.indexOf(token);
  if (first === -1) return null;
  let chosen = first;
  while (first !== -1) {
    if (isBoundary(text, first)) {
      chosen = first;
      break;
    }
    first = lowerText.indexOf(token, first + 1);
  }
  return Array.from({ length: token.length }, (_, k) => chosen + k);
}

function toRanges(positions: readonly number[]): MatchRange[] {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const p of sorted) {
    const last = ranges[ranges.length - 1];
    if (last?.[1] === p) last[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  return ranges;
}

/**
 * Fuzzy-match `query` against `text`.
 *
 * @returns the score (higher is better) and the merged highlight ranges, or
 *   null when some query token is not a subsequence of the text. An empty or
 *   whitespace-only query returns null: there is nothing to rank by.
 * @example
 *   scoreMatch("exc", "example.com") // { score: …, ranges: [[0,2],[8,9]] }
 */
export function scoreMatch(
  query: string,
  text: string,
  options: ScoreOptions = {},
): FuzzyMatch | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || text.length === 0) return null;
  const lowerText = text.toLowerCase();
  let total = 0;
  const allPositions: number[] = [];
  for (const token of tokens) {
    const fuzzy = subsequencePositions(lowerText, token);
    if (!fuzzy) return null;
    const contiguous = substringPositions(text, lowerText, token);
    const fuzzyScore = scorePositions(text, fuzzy);
    const contiguousScore = contiguous ? scorePositions(text, contiguous) : -Infinity;
    const positions = contiguousScore >= fuzzyScore ? contiguous! : fuzzy;
    if (options.maxSpreadFactor !== undefined) {
      const spread = positions[positions.length - 1]! - positions[0]! + 1;
      if (spread > token.length * options.maxSpreadFactor + SPREAD_SLACK) return null;
    }
    total += Math.max(contiguousScore, fuzzyScore);
    allPositions.push(...positions);
  }
  if (lowerText === query.trim().toLowerCase()) total += BONUS_EXACT;
  total -= Math.min(MAX_LENGTH_PENALTY, text.length * PENALTY_LENGTH_PER_CHAR);
  return { score: Math.round(total * 100) / 100, ranges: toRanges(allPositions) };
}

export interface RankedCandidate<T> extends FuzzyMatch {
  item: T;
}

/**
 * Score every candidate's text against the query and return the matches best
 * first. Ties break on the shorter text, then alphabetically, so results are
 * stable across requests.
 *
 * @param textOf the string to match for each item.
 * @param limit maximum number of results (all when omitted).
 */
export function rankCandidates<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
  options: ScoreOptions & { limit?: number } = {},
): Array<RankedCandidate<T>> {
  const ranked: Array<RankedCandidate<T> & { text: string }> = [];
  for (const item of items) {
    const text = textOf(item);
    const match = scoreMatch(query, text, options);
    if (match) ranked.push({ item, text, ...match });
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.text.length - b.text.length || a.text.localeCompare(b.text),
  );
  const limited = options.limit === undefined ? ranked : ranked.slice(0, options.limit);
  return limited.map(({ item, score, ranges }) => ({ item, score, ranges }));
}
