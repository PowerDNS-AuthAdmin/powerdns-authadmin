# `drizzle/` - generated SQL migrations

Files in this directory are produced by `npm run db:generate` and applied by
`npm run db:migrate`. **Do not hand-edit** generated `*.sql` files after they're
committed - write a follow-up migration instead.

## Workflow

1. Edit a schema file under `lib/db/schema/`.
2. Run `npm run db:generate`. Drizzle Kit diffs the schema against the latest
   snapshot in `meta/` and emits a new `NNNN_<random_name>.sql` plus an updated
   snapshot.
3. **Review the generated SQL.** Drizzle is good but not perfect. Common things
   to double-check: column drops, type changes (Postgres often needs USING
   clauses), index renames.
   - **SQLite table rebuilds** (`CREATE __new_x; INSERT … SELECT; DROP x; RENAME`)
     come wrapped in `PRAGMA foreign_keys=OFF; … PRAGMA foreign_keys=ON;`. That
     pragma is **inert**: drizzle's migrator runs every pending migration inside
     one `BEGIN … COMMIT`, and SQLite ignores `PRAGMA foreign_keys` inside a
     transaction. If enforcement were on, the `DROP TABLE` would cascade into every
     child table (`ON DELETE CASCADE` / `SET NULL`). `scripts/migrate.ts` therefore
     turns foreign keys off on the raw connection _before_ calling `migrate()` and
     runs `PRAGMA foreign_key_check` afterwards (`lib/db/migrate-sqlite.ts`). Never
     apply `drizzle-sqlite/` with a tool that leaves the pragma on.
4. Commit `drizzle/NNNN_*.sql` and `drizzle/meta/` together.
5. Apply locally with `npm run db:migrate`. In production, the operator runs
   the same command - ADR 0005 forbids auto-applying on app boot.

## In docker-compose

The `migrate` service (one-shot) runs at compose-up:

```
db:generate (only if no migrations exist) → db:migrate → db:seed
```

So a fresh-clone `docker compose up` works without any manual bootstrap. As
soon as you commit migrations to git, they're treated as the source of truth
and `db:generate` is a no-op.
