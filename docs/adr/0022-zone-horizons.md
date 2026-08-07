# ADR 0022 - Zone horizons: app-side split-horizon classification

- **Status:** Accepted
- **Date:** 2026-08-08
- **Deciders:** @jseifeddine

## Context

Split-horizon DNS is ordinary practice: the same zone name answers one way to the internet and
another way inside the network, usually served by two separate daemons. AuthAdmin fronts both
daemons, and until now it treated a zone **name** as globally unique across the fleet. The
amalgamated zones list collapsed to one row per name and pushed the rest into a "duplicate zones
hidden" notice, which described a deliberate internal zone as an accident of replication (#121).
The operator could not see the internal copy, could not tell which copy they had open, and was told
their zone was a duplicate to be tidied up.

Nothing lower in the stack required name uniqueness. Identity was already `(backend, name)`:
`zone_grants` keys on `(server_id, zone_name)`, zone detail routes as `/zones/<name>?server=<slug>`,
and the create path has no cross-backend uniqueness check - PowerDNS only rejects a name that
already exists on the same backend. The gap was in the amalgamated view and in the app's vocabulary,
not in storage.

PowerDNS itself cannot answer "is this the internal copy?". Both zones are just a zone with a name
on some backend. From 5.0 it grows Views / Networks, its own split-horizon primitive, but that
serves split horizon from ONE daemon and says nothing about the far more common two-daemon
deployment - and nothing about how a fleet-wide list should present them.

## Decision

We will model a zone's **horizon** - which audience it serves - as an app-side classification the
operator sets, and key the amalgamated zone list on `(horizon, name)` instead of `name`.

1. **Vocabulary.** `ZoneHorizon = "public" | "internal"`, in `lib/dns/zone-horizon.ts`. An open enum,
   not a boolean, so a third horizon (DMZ / partner view) needs no migration and no rewrite of every
   `if (internal)`. `public` is the default.
2. **Storage.** A `zone_horizons` table in the app DB, keyed on `(server_id | cluster_id, zone_name)`
   with exactly one scope set (CHECK-enforced). **Sparse**: only a deviation from the default is
   stored, so clearing the flag deletes the row and no existing install needs a backfill.
3. **Scope is the backend, and for a cluster it is the CLUSTER.** A cluster zone's reads and writes
   resolve a peer per request via `choosePeer`, so a classification stored against one peer would
   appear and disappear as the strategy rotated.
4. **Identity.** `dedupeZonesByIdentity()` collapses rows on `(horizon, name)`. Two copies on the
   same horizon still collapse - that really is replication or a genuine name collision. A mirror of
   a managed primary inherits its primary's classification when it has none of its own, via the same
   derived-parent signal the hidden-zones notice already uses.
5. **Surfaces.** A toggle at create time and on the zone's settings tab; an `INTERNAL` badge in the
   zones list next to `CLUSTER` and on zone detail; a Public / Internal filter that appears once the
   fleet has an internal zone; its own audit action, `zone.horizon.update`.

## Rationale

The operator is the only one who knows. Both zones are byte-identical in every property the app can
observe - the internal one is frequently a real public name (`ngn.au.`), so no heuristic on the name
works, and no probe distinguishes them. This is the same shape as the `write_mode` exception in
ADR-0014: an operator-declared field, admitted because PowerDNS is _incapable_ of reporting the
fact, not merely inconvenient to ask.

Keying the list on identity rather than name is the smallest change that fixes the reported problem,
because everything below the list already worked per-backend. The alternative - teaching every
consumer about a second dimension - would have been a far larger change for the same result.

Storing only deviations means the feature is invisible to installs that don't use it: no rows, no
migration data, no behaviour change, and `public` keeps meaning exactly what "unclassified" meant
before.

The honest trade-offs:

- **The classification is app-side.** Restore the app DB from backup without it and zones revert to
  `public`; the zone data on PowerDNS is untouched, but the list collapses again until reclassified.
- **It is advisory, not enforced.** Nothing stops an operator marking the public zone internal. It
  changes presentation and grouping, never what PowerDNS serves.
- **A second dimension in the list.** "One row per name" was easy to explain. "One row per name per
  horizon" is one clause longer, and the hidden-zones notice had to grow a sentence to match.

## Alternatives considered

- **PowerDNS 5.0 Views / Networks.** The daemon's own split-horizon primitive. Requires PDNS ≥ 5.0,
  addresses one daemon serving two views, and does nothing about two separate daemons or about the
  fleet list collapsing. Complementary, not a substitute - a future ADR can layer it.
- **Store the flag in PowerDNS domain metadata.** Travels with the zone and survives an app-DB
  restore, but requires a write to the daemon - impossible for a zone on a backend the operator
  marked `read_only` (#111) or on a mirror we must never write to, which is exactly where internal
  zones often live. It would also need a new kind on the metadata write-policy allowlist.
- **Mark the SERVER internal and inherit to its zones.** Fewer clicks, but a backend legitimately
  hosts both internal-only and publicly-delegated zones, and the operator loses per-zone control. A
  per-zone flag can still be defaulted from a backend-level hint later without revisiting this.
- **Infer from the name (RFC 1918 reverse space, non-delegated TLDs).** Guessing. The reported case
  was a real public name; the two copies are indistinguishable by name by construction.
- **A boolean `is_internal` column.** Simpler, but closes the door on a third horizon and reads
  worse at every call site than a named horizon does.

## Consequences

- The zones list can show an internal and a public copy of one name side by side, each resolved to
  its own primary with its own sync state; the hidden-zones notice counts only same-horizon copies.
- `ZoneRow` gains a required `horizon`, so every producer of a zone row must resolve one. The zones
  page loads the whole classification index in one query and looks up in memory.
- Deleting a zone deletes its classification, so a zone recreated under the same name doesn't
  silently inherit it. Deleting a backend or cluster cascades the same way.
- Follow-ups this opens: horizon-aware zone templates (an internal template that presets the flag),
  a horizon column in provisioning YAML, and eventually PDNS Views for the single-daemon case.

## References

- [#121](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/issues/121) - the report.
- [ADR-0014](./0014-backend-capability-model.md) - the observe-don't-declare rule and the
  `write_mode` exception this decision is modelled on.
- `lib/dns/zone-horizon.ts`, `lib/dns/zone-dedupe.ts`, `lib/db/schema/zone-horizons.ts`,
  `lib/db/repositories/zone-horizons.ts`.
