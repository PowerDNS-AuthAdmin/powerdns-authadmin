# ADR 0017 — Squash the 1.1.0 schema deltas into one migration per dialect

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** @jseifeddine

## Context

Between the 1.0.2 tag and the 1.1.0 release the schema churned while the backend
capability model (ADR-0014) and health advisories (ADR-0015) landed. That left
five unreleased, uncommitted migrations per dialect (`0003`–`0007`) that, taken
together, did this and only this:

- add `pdns_servers.capabilities` (observed daemon capabilities, ADR-0014),
- add `pdns_servers.advertised_addresses` (operator-pinned reachable addresses),
- drop `pdns_servers.role` **and** its `pdns_server_role` enum (PG) — role is now
  derived from observed capabilities, not stored (ADR-0014),
- drop `pdns_servers.primary_id` + its FK/index — primary↔secondary edges are
  derived per-zone from `masters[]`, not pinned (ADR-0014),
- add the `backend_advisories` table + indexes (ADR-0015).

Several of those steps add a column and a later step rebuilds the same table, so
the intermediate history contained add-then-rebuild churn that no released DB had
ever seen. Shipping five files that re-derive the same end state is noise for
operators reviewing migrations and a needless five-step apply.

## Decision

We squash the unreleased `0003`–`0007` of **both** dialects into a single
`0003_backend_caps_advisories_squash` per dialect, generated fresh against the
committed `0002` snapshot. The released baseline (`0000`–`0002`) is untouched —
any DB already at `0002` applies exactly one new migration to reach 1.1.0.

## Rationale

The squashed `0003` is the minimal, reviewable delta from the last _released_
schema. Because no production DB ever applied the intermediate `0003`–`0007`,
collapsing them changes nothing observable and removes the add-then-rebuild
churn. Keeping `0000`–`0002` intact means existing installs migrate forward with
no special handling.

**The SQLite gotcha (load-bearing).** Drizzle-Kit generates a SQLite column drop
as a table rebuild: `CREATE __new` → `INSERT … SELECT … FROM old` → `DROP old` →
`RENAME`. When squashing, the _new_ columns (`capabilities`,
`advertised_addresses`) are added by this same migration, so they do **not**
exist on the source table at copy time — yet Drizzle lists them on both sides of
the `INSERT … SELECT`. SQLite's legacy "double-quoted identifier falls back to a
string literal" misfeature means `SELECT "capabilities" FROM pdns_servers`
doesn't error; it copies the literal text `'capabilities'` into every migrated
row. That silently corrupts data instead of failing loudly. We hand-edit the
generated SQLite migration to omit those two columns from the copy so existing
rows default to `NULL` (the backend poller repopulates them on first probe). The
edit is annotated in the `.sql` and is safe because the migration has never been
applied anywhere. The Postgres path is unaffected — it uses real
`ALTER TABLE … ADD/DROP COLUMN`, no rebuild, no quoting fallback.

## Alternatives considered

- **Ship `0003`–`0007` as-is.** Five files to reach a state no released DB has
  seen, with intermediate add-then-rebuild steps. Rejected as noise.
- **Re-baseline everything into a new `0000`.** Would orphan installs already at
  `0002` (their `__drizzle_migrations` ledger wouldn't match). Rejected — the
  released baseline must stay stable.
- **Leave the broken SQLite `INSERT … SELECT` alone.** It "passes" because of the
  string-literal fallback, so CI on a fresh DB stays green while real installs
  with existing servers get corrupted `capabilities`. Rejected outright.

## Consequences

- One migration per dialect to go from 1.0.2 → 1.1.0; both regenerated together
  on any future schema change, per the standing dual-dialect rule.
- The SQLite squash carries a manual edit. Future squashes that drop a column in
  the same migration that adds another must apply the same check — verify the
  `INSERT … SELECT` references only columns that exist on the _source_ table.
- A `sqlite3`-CLI apply test against a DB seeded with a real server row (NULLs,
  not `'capabilities'`, in the new columns) is the regression guard; the
  Postgres integration suite (ADR-0011 boot-migrate path) covers the PG side.

## References

- ADR-0011 (migrations run at app-container boot), ADR-0014 (capability model),
  ADR-0015 (health advisories).
- SQLite: [Keywords & quoting / the double-quote misfeature](https://www.sqlite.org/quirks.html#double_quoted_string_literals_are_accepted).
