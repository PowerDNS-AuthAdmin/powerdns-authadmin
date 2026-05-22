# ADR 0011 — Migrations run at app-container boot

- **Status:** Accepted. **Supersedes [ADR 0005](./0005-migrations-explicit.md).**
- **Date:** 2026-05-18
- **Deciders:** @jseifeddine

## Context

ADR 0005 said the project would never auto-apply migrations at app boot — that migrations were
an explicit operator action, and that a one-shot `migrate` sidecar service in
`docker compose` would carry the explicitness intent over to the container world.

In practice, the sidecar shape has costs that outweigh the explicitness gain
for the deployment shapes this project actually targets:

- **Two-deploy mental model.** Every operator iterating on the stack has to
  remember the order: pull, run `migrate`, only then start `app`. With one
  container instead of two, the boot order is a fact of the entrypoint, not
  a fact the operator has to know.
- **SQLite has no notion of a separate sidecar writer.** The SQLite variant
  added in this commit owns a single file on a shared volume. A "migrate
  container" attached to the same volume would still be SQLite's only
  writer — the sidecar shape is theatre, not enforcement.
- **The "explicit operator action" frame leaked.** Operators bringing up the
  stack on a new host either ran `docker compose up` and got migrations for
  free (sidecar dependency on `service_healthy`), or they ran `docker
compose run --rm migrate` and were surprised that it didn't "do" anything
  visible. Either way the explicitness was implicit.

What we still want from ADR 0005:

- **Single-writer safety.** When the app scales to multiple replicas, only
  one of them should actually apply pending migrations on cold start.
- **Operator opt-out for fancy CI/CD flows.** Some operators want to run
  migrations from CI before pods are even allowed to come up — the new
  shape needs a switch for that.

## Decision

Migrations run inside the app container's entrypoint, before the Next.js
server starts. Both compose files use the same image; there is no migrate
sidecar.

- The entrypoint is `docker/entrypoint.mjs`. It spawns
  `node scripts/migrate.js`, then dynamic-imports the Next.js standalone
  server. Exit code from migrate aborts the boot — a broken migration is
  a refused start, not a degraded run.
- `scripts/migrate.ts` (compiled to `scripts/migrate.js` at build time)
  inspects `DATABASE_URL`:
  - `postgres://...` / `postgresql://...` → Drizzle's pg migrator over the
    `drizzle/` folder, wrapped in a `pg_advisory_lock` so multi-pod boot
    serializes on one writer.
  - `file:...` / `sqlite:...` → Drizzle's better-sqlite3 migrator over the
    `drizzle-sqlite/` folder. No lock needed; SQLite is single-writer by
    construction.
- `MIGRATE_ON_BOOT=false` opts out for the out-of-band-migrations workflow.
  The entrypoint logs the skip and proceeds to the server boot.

## Consequences

Positive:

- One container, one entrypoint. Operators bring the stack up with
  `docker compose up` and the rest is mechanical.
- The SQLite variant works the same as Postgres — one shared compose
  shape, one mental model.
- The Postgres advisory lock keeps multi-replica deployments safe; the
  failure mode for the few-second lock-wait window is "the second pod
  boots a beat later," not a corrupted migration.

Negative:

- A migration error now appears as a failed-boot loop instead of a
  separate-step error. Operators have to read the app container logs
  to triage. Compose's "container keeps restarting" surface makes this
  visible; we'll add a `/readyz` check that reports migration failure
  if it becomes a common confusion.
- The runner image carries `drizzle-orm`, `pg`, and `better-sqlite3` for
  the migrate step even though only one driver runs at any deploy. The
  cost is ~30MB of node_modules, which is below the noise floor on the
  base image size.
- We moved the runner image off distroless (`gcr.io/distroless/nodejs22`)
  to `node:22-bookworm-slim`. The distroless tracing didn't pull in the
  modules `scripts/migrate.js` needs, so the runner now ships a more
  conventional Node image. Documented in the Dockerfile header.

## Notes for operators

- **Production multi-replica:** the advisory lock means concurrent boots
  are safe but serial. If your cold-start fleet is large enough that the
  serial wait matters, set `MIGRATE_ON_BOOT=false` in the deployment env
  and run `npm run db:migrate` as a pre-deploy step in CI/CD instead.
- **Single-instance SQLite:** zero config; the entrypoint Just Works.
  Migrations run on first boot and on every subsequent restart (no-op when
  there's nothing pending).
