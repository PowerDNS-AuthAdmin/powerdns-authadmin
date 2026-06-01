# ADR 0005 - Migrations are never auto-applied on app boot

- **Status:** Superseded by [ADR 0011](./0011-migrate-on-app-boot.md)
- **Date:** 2026-05-16
- **Deciders:** @jseifeddine

## Context

Some frameworks auto-run database migrations when the app starts. This is convenient in
development and dangerous in production: a long migration can hold a deploy hostage, a bad
migration can corrupt data before anyone can stop it, and concurrent rollouts can apply the same
migration twice. We want operator control over those failure modes.

## Decision

Migrations are **never** automatically applied during application startup. The operator runs them
explicitly via `npm run db:migrate` (Drizzle Kit), and the app refuses to start if the schema
version doesn't match what the code expects.

## Rationale

- **Operator control.** Production deploys plan migrations the way they plan everything else -
  with maintenance windows, rollback plans, and pre-flight checks. Auto-apply bypasses all of that.
- **Failure isolation.** A failing migration is a known event the operator can react to. A
  silent partial migration that fails halfway through, then the app boots anyway and serves
  garbage data, is a much worse failure mode.
- **Concurrent rollouts.** When two pods start at the same time and both try to apply a
  migration, you get either a deadlock or a half-applied state. Explicit migration eliminates the
  race.

## Consequences

- The deployment runbook includes a "run migrations" step.
- The app's `/readyz` endpoint refuses ready status if the schema version table is behind. This
  pulls the new pod out of rotation until the operator runs migrations.
- Migration files in `drizzle/` are committed and reviewed like code. They are never edited after
  merge; a correction is a new migration.

## Alternatives considered

- **Auto-apply on startup.** Standard Django / Rails pattern. Rejected - see Rationale.
- **Auto-apply with a lock.** Apply on first pod start, others wait. Reduces concurrency risk but
  still bypasses operator control during the wrong kind of failure. Rejected as a half-measure.
- **Manual SQL, no migration tool.** Drizzle Kit gives us reproducible diffs from schema changes;
  hand-rolled SQL is more error-prone. Rejected.

## References

- Drizzle Kit migration workflow
- [ADR 0011](./0011-migrate-on-app-boot.md) (revisits this decision for containerized deploys)
