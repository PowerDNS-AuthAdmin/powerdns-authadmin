# Upgrading

PowerDNS-AuthAdmin ships as a single image and runs its own database migrations on
boot, so upgrading is usually "pull a new tag and recreate the container." This
page covers doing it safely.

## Before you upgrade

1. **Read the [CHANGELOG](../CHANGELOG.md)** for the target version — note any
   breaking changes.
2. **Back up the database** (and your `APP_ENCRYPTION_KEY`):
   - SQLite: copy the DB file / snapshot the data volume.
   - Postgres: `pg_dump`.
     See [Installation → Backups](./02-INSTALLATION.md#backups).
3. **Pin a version tag** in production rather than `:latest`, so deploys are
   deterministic and you know exactly what you're moving from and to.

## Upgrade

```sh
docker compose pull         # fetch the new image tag
docker compose up -d        # recreate the app container
docker compose logs -f app  # watch migrations apply
```

On boot the entrypoint runs migrations, then the seed (idempotent), then any
provisioning (skipped after first boot), then starts the server. Migration logs
are intentionally loud — you'll see the pending list and the applied names. If a
migration fails, **the container refuses to start** rather than running on a
half-migrated schema; fix the cause and restart.

## Verify

- `GET /readyz` returns 200 once migrations match the expected version.
- Sign in; check **Admin → PowerDNS servers** shows backends **Reachable**, and
  the dashboard has no unexpected attention banners.

## Rollback

Migrations are **forward-only** — there are no automated down-migrations. To roll
back the application image you must also restore the database to its
pre-upgrade backup, because a newer migration may have changed the schema in ways
the older image doesn't understand.

```sh
# 1. stop the app   2. restore the DB backup   3. pin the previous image tag
docker compose down
# …restore Postgres dump / SQLite file…
docker compose up -d
```

This is why **the pre-upgrade backup is non-negotiable**: it's your only rollback
path.

## Multi-replica notes (Postgres)

Several replicas can boot at once — the migration step takes a `pg_advisory_lock`
so exactly one applies migrations while the others wait. Combined with `/readyz`
gating, a rolling deploy won't send traffic to a replica until its schema is
current. To run migrations as a separate pipeline step instead, set
`MIGRATE_ON_BOOT=false` and run `npm run db:migrate` before rolling the app.

---

[← Docs index](./README.md)
