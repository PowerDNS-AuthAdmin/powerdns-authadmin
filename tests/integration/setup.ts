/**
 * tests/integration/setup.ts
 *
 * Vitest setupFiles hook for the integration suite. Verifies the test
 * stack is reachable before any test file is loaded — if it isn't, fail
 * loud and direct the user at `tests/integration/run.sh`.
 *
 * Suite-wide preconditions:
 *   - $TEST_APP_URL responds 200 on /healthz
 *   - Postgres at $TEST_DATABASE_URL accepts a connection
 */

import { Client } from "pg";

const TEST_APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";
const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://pdns:pdns@localhost:5432/powerdns_authadmin";

async function ping(): Promise<void> {
  const res = await fetch(`${TEST_APP_URL}/healthz`).catch(() => null);
  if (!res?.ok) {
    throw new Error(
      `Integration stack not reachable at ${TEST_APP_URL}/healthz.\n` +
        `Bring it up with:  ./tests/integration/run.sh\n` +
        `Or set TEST_APP_URL if your stack is elsewhere.`,
    );
  }
  const c = new Client({ connectionString: TEST_DATABASE_URL });
  try {
    await c.connect();
    await c.query("SELECT 1");
  } catch (err) {
    throw new Error(
      `Test Postgres not reachable at ${TEST_DATABASE_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  } finally {
    await c.end().catch(() => undefined);
  }
}

await ping();
