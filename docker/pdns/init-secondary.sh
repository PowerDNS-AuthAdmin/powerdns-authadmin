#!/bin/sh
# docker/pdns/init-secondary.sh
#
# Run once by the init container before each Secondary boots. Applies the
# gsqlite3 schema if the DB is empty, then inserts the configured
# Primary IP(s) into the `supermasters` table so the auto-secondary
# flow can pick up zones via NOTIFY.
#
# Env knobs:
#   DB                path to the SQLite file the Secondary will use
#                     (default: /var/lib/powerdns/pdns.sqlite)
#   SCHEMA            path to the gsqlite3 schema file mounted by compose
#                     (default: /schema.sqlite3.sql)
#   PRIMARY_IPS       comma-separated list of primary IPs to register as
#                     supermasters. Each is inserted as
#                     `(ip, 'primary', 'pda')`. Repeated runs are idempotent
#                     (INSERT OR IGNORE keyed on the existing UNIQUE).

set -eu

DB="${DB:-/var/lib/powerdns/pdns.sqlite}"
SCHEMA="${SCHEMA:-/schema.sqlite3.sql}"

mkdir -p "$(dirname "$DB")"

if [ ! -s "$DB" ]; then
  echo "[init-secondary] applying schema to $DB"
  sqlite3 "$DB" < "$SCHEMA"
fi

if [ -n "${PRIMARY_IPS:-}" ]; then
  echo "[init-secondary] registering supermasters: $PRIMARY_IPS"
  echo "$PRIMARY_IPS" | tr ', ' '\n\n' | while read -r ip; do
    [ -z "$ip" ] && continue
    sqlite3 "$DB" \
      "INSERT OR IGNORE INTO supermasters (ip, nameserver, account) VALUES ('$ip', '${SELF_NS}', 'pda');"
  done
fi

echo "[init-secondary] done"
