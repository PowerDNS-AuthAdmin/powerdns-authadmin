#!/bin/sh
# docker/pdns/init-primary.sh
#
# Run once by the init container before the Primary boots. Applies the
# gsqlite3 schema if the DB is empty. Primaries don't need supermaster
# rows; they're only ever the source.

set -eu

DB="${DB:-/var/lib/powerdns/pdns.sqlite}"
SCHEMA="${SCHEMA:-/schema.sqlite3.sql}"

mkdir -p "$(dirname "$DB")"

if [ ! -s "$DB" ]; then
  echo "[init-primary] applying schema to $DB"
  sqlite3 "$DB" < "$SCHEMA"
else
  echo "[init-primary] existing DB at $DB - skipping"
fi

echo "[init-primary] done"
