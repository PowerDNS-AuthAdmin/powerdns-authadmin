# ADR 0014 — Per-zone authority + observed daemon capabilities (retire per-server role)

- **Status:** Accepted
- **Date:** 2026-05-23
- **Deciders:** @jseifeddine

## Context

We modeled each backend with a single `role` (`primary | secondary`) plus an optional `primaryId`
pin linking a secondary to exactly one primary. Multi-primary "clusters" are a separate grouping
with an API-routing picker (ADR-0013, `cluster-picker.choosePeer`).

**PowerDNS has no server-level role.** Two real things exist:

1. **Per-zone authority.** Each zone has a `kind` — `Native | Master/Primary | Slave/Secondary |
Producer | Consumer` — and a slave carries `masters[]`. Authority is decided per zone, not per
   daemon.
2. **Per-daemon capability.** Behaviour is governed by config flags readable from the read-only
   `/config` endpoint: `primary`/`master`, `secondary`/`slave`, `autosecondary`/`superslave`,
   `launch` (which backends), `g*-dnssec`, `api`.

A single daemon legitimately runs `primary=yes secondary=yes` and is Master for some zones, Slave
for others, and Native for others **at the same time**. Our `role` is an app-level fiction that
mis-models every mixed / mesh / multi-primary deployment. Symptoms already seen: a backend
reconfigured as a secondary surfaced "Orphan secondaries" and an empty zone list; read-only
behaviour had to be moved off `role` onto zone `kind` (done); the `/config` advisory still keys off
`role`. `role` is the remaining fiction.

## Decision

1. **Retire `role` and `primaryId`.** A backend is a connection — identity, base URL, serverId,
   api-key, default/enabled flags — with no declared authority.
2. **Observe, don't declare.** Persist a **capability snapshot** per backend, refreshed on the
   existing poll from `/config` + `/servers/{id}`: `api`, `primary`, `secondary`, `autosecondary`,
   `launch` backends, per-backend DNSSEC, daemon + API version. Same write path and cache pattern as
   the version cache — a sanctioned `lib/pdns → lib/db` bridge (ADR-0013).
3. **Gate editability on zone `kind`** via one ops resolver:
   `zoneCapabilities(kind) → { rrsets, metadata, masters, dnssec, axfrRetrieve, delete }`.
   Generalizes the existing `isReadOnlyZoneKind` and encodes the _real_ writable options on a
   Slave (masters, metadata, retrieve-now, delete) instead of treating it as a flat read-only.
4. **Derive replication topology from truth.** A slave's `masters[]` are DNS-layer AXFR addresses,
   not API URLs. Add a per-backend **advertised DNS address set** — default-suggested from the API
   URL host, overridable, multi-valued. Draw an edge when a `masters[]` entry matches a backend's
   advertised address; unmatched masters render as **external/unmanaged nodes**, never a false
   "orphan." Matching is on AXFR address, **not** NS membership, so hidden primaries work.
5. **One `backend group`** replaces the `primaryId` pin and subsumes the multi-primary cluster. A
   group is app-level grouping for API routing (`choosePeer` operates within a group) and visual
   clustering — **never** an authority gate.

   > **Amendment (2026-05-23):** rather than a new many-to-many `backend_group` table, we reuse the
   > existing `pdns_clusters` table + `cluster_id` membership (1:N) as the group. None of the
   > supported topologies (standalone / primary+secondaries / multi-primary) need a backend in more
   > than one group, so many-to-many added churn and risk for no benefit. We drop only `primary_id`;
   > a primary's secondaries are now the secondary-capable members of its group. `choosePeer` filters
   > group members to write-capable ones so a secondary in a group is never a write target.

6. **Expose a single `BackendProfile`** (identity, reachability, capabilities, zone inventory by
   kind, advisories) that dashboard / server-detail / zone-detail / topology all consume. No feature
   re-derives role logic.

## Rationale

Model the two things PowerDNS actually has — per-zone kind, per-daemon capability — and _derive_
everything else. Operators declare nothing PDNS can tell us, and the app can't drift from reality
because it re-reads reality each poll. Honest trade-offs: more moving parts (a capability snapshot, a
group table, and an advertised-address set) and a non-trivial dual-dialect migration; topology
matching is best-effort and degrades to "external node" whenever the API host ≠ the DNS address
(common in real deployments) — incomplete, but never wrong.

## Alternatives considered

- **Keep `role`, layer capabilities as advisory only.** Leaves the flaw; mixed-mode still
  mis-modeled.
- **Demote `role` to a non-authoritative hint.** Half-measure with two sources of truth; rejected
  by decision.
- **Auto-derive the match address from NS records, or require API URL == NS name.** Hidden
  primaries aren't in the NS set, and the API URL ≠ the DNS IP in real deployments. An explicit,
  URL-seeded, overridable address set is the only honest match key.

## Consequences

- `pdns_servers`: drop `role`, `primaryId`; add `capabilities` (+ `fetchedAt`) and
  `advertisedAddresses`. Dual-dialect migration (PG + SQLite), run at boot (ADR-0011).
  - **Existing clusters are preserved** (we reuse `pdns_clusters` + `cluster_id`, per the
    amendment, so multi-primary groups carry over untouched).
  - **`primary_id` pins are NOT backfilled.** Under "derive from truth," a primary→secondary edge
    comes from each mirror zone's `masters[]`, not from a stored pin — so the migration simply drops
    the column and the edge re-derives on the first poll. The only case this loses is a pinned
    secondary whose API host ≠ its DNS address AND that isn't in a cluster; it degrades to a
    standalone secondary (visible + editable), never a false "orphan," and the operator can set its
    advertised address or group it. Backfilling would mean synthesizing cluster rows (with generated
    UUIDs/slugs) in cross-dialect SQL for a relationship the model no longer needs — churn for no
    benefit, so we don't.
- The `/config` advisory keys off capabilities-vs-inventory, not `role` — feeding ADR-0015's bell.
- "Orphan secondary" UI and role pickers are removed; server forms gain an advertised-address field
  with a URL-seeded default; zone editability comes from the kind ops resolver.
- `cluster-picker` / `sync` operate on group membership — aligns with ADR-0013's "relocate above
  `lib/pdns`" future work.

## References

- ADR-0013 (PDNS DB bridge, `cluster-picker`), ADR-0010 (per-RRset concurrency), ADR-0004
  (three-layer architecture)
- CLAUDE.md (standalone / primary+secondaries / multi-primary topologies)
- Follow-up: ADR-0015 (backend health advisories)
