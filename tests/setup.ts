/**
 * tests/setup.ts
 *
 * Vitest setupFiles hook. Runs before every test file and primes the
 * environment variables that `lib/env.ts` validates at module load. Without
 * this, any test whose transitive imports reach `lib/env` (logger, audit,
 * pdns client, anything db-shaped) blows up at import time before a single
 * test runs.
 *
 * The values are placeholders sized to pass schema validation — never real
 * secrets. Tests that exercise encryption or the database should still spin
 * up their own scoped fixtures rather than relying on these defaults.
 */

// 32-byte value, base64-encoded — passes `secretKey.min(32)` and decodes to
// the 32 bytes that `APP_ENCRYPTION_KEY` requires for AES-256-GCM.
const TEST_BASE64_32 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // "0123456789abcdef0123456789abcdef"

process.env["APP_URL"] ??= "http://localhost:3000";
process.env["APP_SECRET_KEY"] ??= "test-secret-key-padded-to-meet-min-32-chars-please";
process.env["APP_ENCRYPTION_KEY"] ??= TEST_BASE64_32;
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
process.env["LOG_LEVEL"] ??= "fatal";
// NODE_ENV is typed `readonly` in @types/node; the cast is intentional.
(process.env as Record<string, string>)["NODE_ENV"] ??= "test";
