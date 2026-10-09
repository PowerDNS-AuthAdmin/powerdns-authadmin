/**
 * app/api/admin/backup/restore/route.ts
 *
 * Super-admin-only restore of a JSON backup produced by
 * `/api/admin/backup/export`. Merge-mode only: every row is inserted
 * with `ON CONFLICT DO NOTHING`, so a restore against a non-empty
 * database leaves any pre-existing rows in place and only adds the
 * ones missing. Operators wanting a true wipe-and-restore should
 * `pg_dump` / `sqlite .restore` the DB directly.
 *
 * Validation:
 *   - meta.schema_version must be 1.
 *   - tables must be an object keyed by known names.
 *   - row shapes are trusted (the export was produced by this app);
 *     a malformed row fails the per-row insert and is counted as `failed`.
 *
 * Encrypted columns ride through as-is - the restore target MUST
 * share the source `APP_ENCRYPTION_KEY`, or operator-issued secrets
 * (OIDC client secret, SAML SP private key, LDAP bind password,
 * refresh tokens) end up un-decryptable.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { assertSettingsBackupAllowed } from "@/lib/auth/settings-lock";
import { db } from "@/lib/db";
import { normalizeBackupRow } from "@/lib/db/backup-codec";
import { serialSequenceResync } from "@/lib/db/sql-dialect";
import {
  apiTokens,
  auditLog,
  authProviderSlugs,
  backendAdvisories,
  ldapProviders,
  oidcProviders,
  pdnsClusters,
  pdnsServers,
  roleAssignments,
  roles,
  samlProviders,
  settings,
  teamMembers,
  teams,
  users,
  zoneGrants,
  zoneTemplates,
} from "@/lib/db/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { logger } from "@/lib/logger";

interface BackupBundle {
  meta?: { schema_version?: unknown };
  tables?: Record<string, unknown>;
}

/**
 * Forward-dependency order - parents first, children last. Inserts run in
 * this order so the per-row FK references already exist by the time the
 * child table runs. Tables not in the export are silently skipped.
 */
const TABLE_ORDER = [
  ["settings", settings],
  ["roles", roles],
  ["teams", teams],
  ["users", users],
  ["team_members", teamMembers],
  ["role_assignments", roleAssignments],
  ["pdns_clusters", pdnsClusters],
  ["pdns_servers", pdnsServers],
  ["zone_grants", zoneGrants],
  ["zone_templates", zoneTemplates],
  ["oidc_providers", oidcProviders],
  ["saml_providers", samlProviders],
  ["ldap_providers", ldapProviders],
  ["auth_provider_slugs", authProviderSlugs],
  ["backend_advisories", backendAdvisories],
  ["api_tokens", apiTokens],
  ["audit_log", auditLog],
] as const;

/**
 * Tables whose primary key is a database-generated serial. Restored rows carry
 * their original ids, so the sequence has to be moved past them afterwards or
 * the next ordinary insert collides (Postgres only - see `serialSequenceResync`).
 */
const SERIAL_PK_TABLES: ReadonlyArray<readonly [string, string]> = [["audit_log", "id"]];

export interface RestoreTableCounts {
  attempted: number;
  /** Rows the database actually added. */
  inserted: number;
  /** Rows that already existed (ON CONFLICT DO NOTHING). */
  skipped: number;
  /** Rows the database rejected; each one is logged. */
  failed: number;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user, globalPermissions } = await requireUser();
    if (!globalPermissions.has("system.backup")) {
      throw new ForbiddenError("Missing system.backup.");
    }
    await requireCsrf(request);
    assertSettingsBackupAllowed();

    // Bound the body before parsing: a restore is a whole-database write and
    // JSON.parse on an unbounded payload is a trivial memory DoS for anyone
    // holding `system.backup`.
    const MAX_RESTORE_BYTES = 64 * 1024 * 1024;
    const raw = await request.text();
    if (raw.length > MAX_RESTORE_BYTES) {
      throw new ValidationError("Backup bundle exceeds the 64 MiB restore limit.");
    }
    let bundle: BackupBundle;
    try {
      bundle = JSON.parse(raw) as BackupBundle;
    } catch {
      throw new ValidationError("Body is not valid JSON.");
    }
    if (
      !bundle.meta ||
      typeof bundle.meta !== "object" ||
      bundle.meta.schema_version !== 1 ||
      !bundle.tables ||
      typeof bundle.tables !== "object"
    ) {
      throw new ValidationError(
        "Invalid backup bundle - expected { meta: { schema_version: 1 }, tables: {...} }.",
      );
    }

    const counts: Record<string, RestoreTableCounts> = {};

    await db.transaction(async (tx) => {
      for (const [name, table] of TABLE_ORDER) {
        const rows = bundle.tables?.[name];
        if (!Array.isArray(rows) || rows.length === 0) continue;

        // JSON carried dates as ISO strings and bigserial ids as decimal
        // strings; the codec converts them back by COLUMN TYPE and drops any
        // key that isn't a column (so user-supplied keys can never name a
        // property outside the table's fixed allowlist).
        const prepared = rows.map((r) =>
          normalizeBackupRow(table, (r ?? {}) as Record<string, unknown>),
        );

        let inserted = 0;
        let failed = 0;
        for (const row of prepared) {
          try {
            // `.returning()` yields the inserted row, or nothing when the
            // conflict clause swallowed it - the only way to tell a real
            // insert from a no-op without a before/after count.
            const written = await tx.insert(table).values(row).onConflictDoNothing().returning();
            if (written.length > 0) inserted += 1;
          } catch (err) {
            failed += 1;
            logger.warn(
              { table: name, err: err instanceof Error ? err.message : "unknown" },
              "admin.backup.restore.row-failed",
            );
          }
        }
        counts[name] = {
          attempted: prepared.length,
          inserted,
          skipped: prepared.length - inserted - failed,
          failed,
        };
      }

      for (const [tableName, column] of SERIAL_PK_TABLES) {
        if (!counts[tableName] || counts[tableName].inserted === 0) continue;
        const statement = serialSequenceResync(tableName, column);
        if (statement) await tx.execute(statement);
      }

      const hdrs = await headers();
      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "system.backup.restored",
          resource: { type: "system", id: null },
          after: { mode: "merge", counts },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    const anyFailed = Object.values(counts).some((c) => c.failed > 0);
    return Response.json({ ok: !anyFailed, counts });
  } catch (err) {
    return errorResponse(err, "admin.backup.restore.route.error");
  }
}
