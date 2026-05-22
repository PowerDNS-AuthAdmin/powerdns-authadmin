# ADR 0010 — Per-RRset optimistic concurrency for the editor

- **Status:** Proposed
- **Date:** 2026-05-17
- **Deciders:** @jseifeddine

## Context

The RRset editor at `/zones/[zoneId]` allows simultaneous edits from multiple operators across
multiple browser tabs. Without a concurrency guard, the last writer silently overwrites every
prior edit; the audit log records the sequence but the dropped content is gone from the live zone.

An earlier iteration shipped a **zone-level optimistic check** keyed on PDNS's `edited_serial`:
the client sent the zone serial it had loaded; the PATCH route compared it to the live PDNS
serial and returned 409 on mismatch. This was removed for the reason captured in
`app/api/admin/pdns/zones/[zoneId]/rrsets/route.ts`:

> the wrong granularity (every successful edit advances the zone's serial so consecutive edits
> in the same session falsely 409'd against the user's own prior write, since router.refresh()
> is async and the page's snapshot is stale until it propagates).

That left the editor as **last-write-wins**, with the audit log as the only reconciliation
path. This ADR replaces the discarded approach with per-RRset hashing.

## Decision

Add **per-RRset** optimistic locking, keyed on a structural hash of each RRset's content as the
client saw it. The PATCH route accepts an optional `expected: { hash: string }` field per
change pair; the server computes the same hash from the live PDNS rrset and returns 409 only
when THIS rrset was modified by someone else between load and save.

### Hash shape

Deterministic over the RRset's structural content:

```ts
function rrsetHash(rrset: {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
}): string {
  // Canonicalize before hashing so equivalent rrsets produce the same hash:
  //   - sort records by (content, disabled) lexicographically;
  //   - normalize disabled to a concrete boolean.
  const canonical = JSON.stringify({
    name: rrset.name.toLowerCase(),
    type: rrset.type.toUpperCase(),
    ttl: rrset.ttl,
    records: [...rrset.records]
      .map((r) => ({ content: r.content, disabled: r.disabled === true }))
      .sort((a, b) => a.content.localeCompare(b.content)),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
```

Truncated to 16 hex characters (64 bits) — enough collision resistance for an RRset-by-RRset
check (operator concurrency is on the order of dozens of users, not adversaries).

### Wire format

Client sends in the existing PATCH body:

```ts
{
  changes: [
    {
      kind: "update" | "create" | "delete",
      before: RRset | null,
      after: RRset | null,
      expected?: { hash: string },  // NEW: hash of `before` as the client saw it
    },
  ],
}
```

Server:

1. For each change where `expected` is set AND `before` is non-null:
   - Fetch the live rrset from PDNS (already done in the audit `before` capture path).
   - Compute its hash.
   - Compare against `expected.hash`.
2. On mismatch, return 409 with a structured body:

```ts
{
  error: "conflict",
  conflicts: [
    {
      rrsetName: string,
      rrsetType: string,
      reason: "modified" | "deleted",  // deleted = live rrset is gone
      currentHash?: string,            // present when reason="modified"
    },
  ],
}
```

3. On any conflict, the route applies **none** of the changes (transactional all-or-nothing).
   Mixed apply would leave the zone in a partially-edited state the operator didn't intend.

### Client UX

On 409:

- Toast the conflict count + summary ("3 records changed under you").
- Render an inline reconciliation panel showing per-conflict diffs (live vs. your change).
- Operator can either reload (discard their edits) or override (re-submit without `expected`).
  Override is audited with `record.override` action so post-hoc reconciliation has the trail.

### Create + Delete paths

- **Create** (`before: null`): no `expected` makes sense — there's nothing to hash. If two
  operators both create the same (name, type), the second is treated as an update; the
  server-computed hash diff surfaces in the per-RRset audit row for review.
- **Delete** (`after: null`): the `expected.hash` of `before` is still meaningful — the
  operator is asserting "I want to delete this rrset as I last saw it." If someone changed it
  in between, the conflict path fires and the operator decides whether to delete the new
  content.

### Server-side caching to avoid the extra round-trip

The audit `before` snapshot path (line ~180 of `rrsets/route.ts`) already fetches the live
rrset before applying changes. Reuse the same fetch for hash comparison — no additional
HTTP round-trip to PDNS.

## Rationale

- **Per-RRset granularity matches the editor's mental model.** Operators edit one rrset at a
  time; collisions across distinct rrsets shouldn't block each other.
- **Audit log already carries `before` snapshots** — the conflict reconciliation panel can
  reuse the redacted snapshot format from `lib/audit/log.ts`.
- **Hash, not version number.** A version column on rrsets would require schema changes that
  PDNS doesn't expose (we don't own the rrset table). Hashing is server-side, requires zero
  PDNS schema cooperation, and is robust to in-place edits made by other tools.
- **Optional `expected`** preserves backward compatibility: old clients that don't send it
  fall back to last-write-wins, same as today.
- **Override path is audited** so an operator who blew through a 409 is on the audit log; this
  is the security property that lets last-write-wins coexist with the optimistic check.

## Alternatives considered

- **Zone-level `edited_serial` check.** The discarded earlier approach (consecutive own-edits
  false-conflict). The per-RRset hash fixes that without reintroducing the false-positive.
- **ETag / If-Match HTTP semantics.** Conceptually equivalent to the hash field but requires
  per-rrset GET endpoints with their own ETags — adds API surface for marginal gain.
- **PDNS native concurrency.** PDNS's HTTP API has no concurrency primitive (no ETag, no
  If-Match, no row versioning). Per-RRset locking has to live in the app layer.
- **Pessimistic locking (per-rrset edit lock).** Operator A starts editing → lock; B can't
  edit until A times out or commits. Wrong UX for an admin tool — A might walk away with the
  lock open. Pessimistic locks are for shared-document editors with explicit "leave session"
  signals.

## Consequences

- **Wire format change** (additive `expected` field) — backward-compatible.
- **One new pure helper** in `lib/pdns/rrsets.ts` or a new
  `lib/pdns/rrset-hash.ts` — easy to unit-test (pure function over a record).
- **New conflict-response shape** — typed in `lib/pdns/types.ts` so client + server agree.
- **Audit action vocabulary** gains `record.override` (or similar) for the "operator
  acknowledged conflict and re-submitted without `expected`" path.
- **No PDNS API change.** No new schema column. No migration.
- **Integration test surface**: 4 scenarios — happy path (no conflict, applies), single-
  rrset conflict (returns 409, nothing applied), multi-change with one conflict (still
  nothing applied), override path (re-submit without `expected` applies).

## Implementation order

1. Add the pure `rrsetHash(rrset)` helper + unit tests (T+1).
2. Add `expected?: { hash: string }` to the PATCH input Zod schema (T+1).
3. Implement the server-side compare + conflict-response shape; gate on `expected` presence (T+2).
4. Audit `record.override` for the no-`expected` resubmit path (T+2).
5. Integration tests (T+3).
6. Client: extend the editor's submit to include `expected` from the loaded rrset; render
   the conflict reconciliation panel (T+4 / T+5).

Stop after step 3 if shipping in two phases — server-side is useful to any future client
even before the editor learns to send the field.
