#!/usr/bin/env bash
# =============================================================================
# tests/integration/run.sh
#
# Drives the integration suite end-to-end:
#   1. Tear down (down -v) any other powerdns-authadmin-* compose project +
#      remove leftover dangling powerdns-authadmin-* volumes so the test
#      stack starts from a known-clean state.
#   2. Build + boot the test stack (combined topology, project name
#      `powerdns-authadmin-test`) and `--wait` for every container healthy.
#   3. Run vitest with the integration config.
#   4. Tear down (down -v --remove-orphans) unless KEEP_STACK=1.
#
# Cleanup is destructive on purpose: tests assume a clean slate, and a half-
# populated postgres or PDNS backend from an earlier run would make failures
# non-reproducible.
#
# Usage:
#   ./tests/integration/run.sh                      # full cycle
#   KEEP_STACK=1 ./tests/integration/run.sh         # leave stack running
#   ./tests/integration/run.sh tests/integration/auth/login.test.ts   # single file
#
# Tunables (env):
#   COMPOSE_BIN     — defaults to `docker compose`
#   TEST_APP_URL    — defaults to http://localhost:3000
#   KEEP_STACK      — "1" to skip teardown after tests
# =============================================================================

set -euo pipefail

PROJECT_NAME="powerdns-authadmin-test"
COMPOSE_BIN="${COMPOSE_BIN:-docker compose}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_APP_URL="${TEST_APP_URL:-http://localhost:3000}"

cd "$ROOT_DIR"

compose() {
  # shellcheck disable=SC2086
  $COMPOSE_BIN \
    -f docker-compose-combined.yml \
    -f tests/integration/docker-compose.test.yml \
    --project-name "$PROJECT_NAME" \
    "$@"
}

remove_conflicting_projects() {
  # Any other powerdns-authadmin-* project would hold the same host ports
  # AND its volumes would shadow the test stack's data on the next run.
  # Tear them down with -v so the test starts clean — anything you wanted
  # to keep there should already be committed/exported.
  local other
  other=$(docker compose ls -a --filter "name=powerdns-authadmin" --format json 2>/dev/null \
    | python3 -c 'import json,sys; [print(p["Name"]) for p in json.load(sys.stdin) if p.get("Name") and p["Name"] != "'"$PROJECT_NAME"'"]' \
    2>/dev/null || true)
  if [ -n "$other" ]; then
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      echo "[run.sh] removing conflicting project (down -v): $name"
      docker compose --project-name "$name" down -v --remove-orphans >/dev/null 2>&1 || true
    done <<< "$other"
  fi
  # Also nuke any orphaned powerdns-authadmin-* volumes left over from
  # projects that were `docker compose down`'d without -v at some point.
  local orphans
  orphans=$(docker volume ls --filter "name=powerdns-authadmin" --filter "dangling=true" -q 2>/dev/null || true)
  if [ -n "$orphans" ]; then
    echo "[run.sh] removing dangling powerdns-authadmin volumes"
    echo "$orphans" | xargs -I {} docker volume rm {} >/dev/null 2>&1 || true
  fi
}

teardown() {
  if [ "${KEEP_STACK:-0}" = "1" ]; then
    echo "[run.sh] KEEP_STACK=1 — leaving stack running"
    return
  fi
  echo "[run.sh] tearing down test stack"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}

trap teardown EXIT

echo "[run.sh] removing any conflicting compose projects (down -v)"
remove_conflicting_projects

echo "[run.sh] building + booting test stack ($PROJECT_NAME)"
compose up -d --build --wait

echo "[run.sh] waiting for /healthz at $TEST_APP_URL"
deadline=$(( $(date +%s) + 60 ))
until curl -sf "$TEST_APP_URL/healthz" >/dev/null 2>&1; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "[run.sh] FATAL: app did not become healthy within 60s"
    compose logs app | tail -50
    exit 1
  fi
  sleep 1
done
echo "[run.sh] app healthy"

echo "[run.sh] running vitest"
TEST_APP_URL="$TEST_APP_URL" \
TEST_COMPOSE_PROJECT="$PROJECT_NAME" \
  npx vitest run --config vitest.config.integration.ts "$@"
