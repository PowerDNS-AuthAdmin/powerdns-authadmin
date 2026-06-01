/**
 * lib/pdns/tsig.ts
 *
 * TSIG helpers shared across server, client, and tests (no `server-only` so the
 * zone-detail client component can import it too).
 *
 * TSIG key names are DNS names: PDNS returns them WITH a trailing dot in the
 * zone key-id fields ("test.") but WITHOUT one from `/tsigkeys` ("test").
 * Collapsing the two forms is a correctness invariant - a key must never appear
 * twice on a zone or look "still addable" once assigned, and a cascade delete
 * must recognise the dotted reference - so it lives in ONE place rather than
 * being re-implemented per file.
 */

export function stripTrailingDot(name: string): string {
  return name.trim().replace(/\.$/, "");
}
