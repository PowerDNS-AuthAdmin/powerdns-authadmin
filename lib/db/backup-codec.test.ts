/**
 * lib/db/backup-codec.test.ts
 *
 * The backup bundle must round-trip through JSON on both dialects. Before this
 * codec existed the export threw on Postgres (`bigserial` → BigInt is not JSON
 * serialisable) and the restore converted nothing (it looked for `*_at` keys
 * while rows carry drizzle property names like `createdAt`), so every row hit
 * the driver's `value.toISOString()` and failed. Tested against the real table
 * definitions so a schema change that adds a new timestamp or bigint column is
 * covered automatically.
 */

import { describe, expect, it } from "vitest";
import { backupJsonReplacer, normalizeBackupRow, tableColumnEntries } from "./backup-codec";
import { auditLog as pgAuditLog } from "./schema/audit-log";
import { users as pgUsers } from "./schema/users";
import { auditLog as sqliteAuditLog } from "./schema-sqlite/audit-log";
import { users as sqliteUsers } from "./schema-sqlite/users";

const ISO = "2026-10-01T12:34:56.789Z";

describe("backupJsonReplacer", () => {
  it("serialises BigInt ids and Dates so an export with audit rows does not throw", () => {
    const row = { id: 9007199254740993n, ts: new Date(ISO), action: "user.create" };
    const json = JSON.stringify(row, backupJsonReplacer);
    expect(JSON.parse(json)).toEqual({ id: "9007199254740993", ts: ISO, action: "user.create" });
  });

  it("leaves other values untouched", () => {
    expect(JSON.stringify({ a: 1, b: null, c: [true] }, backupJsonReplacer)).toBe(
      '{"a":1,"b":null,"c":[true]}',
    );
  });
});

describe("normalizeBackupRow", () => {
  it("converts every timestamp column of a Postgres row by column type, not key name", () => {
    const out = normalizeBackupRow(pgUsers, {
      id: "00000000-0000-4000-8000-000000000001",
      email: "a@example.com",
      createdAt: ISO,
      updatedAt: ISO,
      lockedUntil: ISO,
      lastLoginAt: null,
      passwordHashUpdatedAt: ISO,
    });
    expect(out["createdAt"]).toBeInstanceOf(Date);
    expect((out["createdAt"] as Date).toISOString()).toBe(ISO);
    expect(out["updatedAt"]).toBeInstanceOf(Date);
    expect(out["lockedUntil"]).toBeInstanceOf(Date);
    expect(out["passwordHashUpdatedAt"]).toBeInstanceOf(Date);
    expect(out["lastLoginAt"]).toBeNull();
    expect(out["email"]).toBe("a@example.com");
  });

  it("converts SQLite `timestamp_ms` columns the same way", () => {
    const out = normalizeBackupRow(sqliteUsers, { createdAt: ISO, lockedUntil: null });
    expect(out["createdAt"]).toBeInstanceOf(Date);
    expect(out["lockedUntil"]).toBeNull();
  });

  it("restores the Postgres bigserial audit id as BigInt and `ts` as Date", () => {
    const out = normalizeBackupRow(pgAuditLog, {
      id: "42",
      ts: ISO,
      actorType: "user",
      action: "user.create",
      resourceType: "user",
    });
    expect(out["id"]).toBe(42n);
    expect(out["ts"]).toBeInstanceOf(Date);
  });

  it("keeps the SQLite audit id a number (its column is not bigint)", () => {
    const out = normalizeBackupRow(sqliteAuditLog, { id: 42, ts: ISO });
    expect(out["id"]).toBe(42);
    expect(out["ts"]).toBeInstanceOf(Date);
  });

  it("drops keys that are not columns, including prototype-polluting ones", () => {
    const hostile = JSON.parse(
      '{"email":"x@example.com","__proto__":{"polluted":true},"constructor":{"x":1},"junk":1}',
    ) as Record<string, unknown>;
    const out = normalizeBackupRow(pgUsers, hostile);
    expect(Object.keys(out)).toEqual(["email"]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("passes an unparseable date through so the database rejects the row", () => {
    const out = normalizeBackupRow(pgUsers, { createdAt: "not a date" });
    expect(out["createdAt"]).toBe("not a date");
  });

  it("covers every date column the schema declares (guards future columns)", () => {
    for (const table of [pgUsers, sqliteUsers, pgAuditLog, sqliteAuditLog]) {
      const dateKeys = tableColumnEntries(table)
        .filter(([, c]) => c.dataType === "date")
        .map(([k]) => k);
      expect(dateKeys.length).toBeGreaterThan(0);
      const out = normalizeBackupRow(table, Object.fromEntries(dateKeys.map((k) => [k, ISO])));
      for (const k of dateKeys) expect(out[k]).toBeInstanceOf(Date);
    }
  });
});
