/**
 * app/api/admin/backup/export/route.ts
 *
 * Super-admin-only JSON export of the app DB. Excludes zone data
 * (PDNS owns it) and the symmetric secrets (`APP_SECRET_KEY` /
 * `APP_ENCRYPTION_KEY`, which stay env-side).
 *
 * Encrypted columns (OIDC client secret, SAML SP private key, LDAP
 * bind password, refresh tokens) are exported as their ciphertext.
 * Useless without `APP_ENCRYPTION_KEY`, which is the point — the
 * export is safe to store next to the source DB without a separate
 * "secret holder" key.
 *
 * Streamed response: `Content-Type: application/json` so operators
 * `curl > backup.json`. The body is a single top-level object with
 * `meta` (version, app version, exported_at) and `tables` keyed by
 * table name → row array.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { db } from "@/lib/db";
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
import { APP_VERSION_LABEL } from "@/lib/app-meta";
import { errorResponse } from "@/lib/http/error-response";
import { ForbiddenError } from "@/lib/errors";

export async function GET(): Promise<Response> {
  try {
    const { user, globalPermissions } = await requireUser();
    if (!globalPermissions.has("system.backup")) {
      throw new ForbiddenError("Missing system.backup.");
    }

    // Pull every export-relevant table in parallel. Order doesn't matter
    // here — the export is a snapshot; restore handles dependency order.
    const [
      usersRows,
      teamsRows,
      teamMembersRows,
      rolesRows,
      roleAssignmentsRows,
      zoneGrantsRows,
      apiTokensRows,
      settingsRows,
      pdnsClustersRows,
      pdnsServersRows,
      oidcRows,
      samlRows,
      ldapRows,
      authProviderSlugsRows,
      zoneTemplatesRows,
      backendAdvisoriesRows,
      auditLogRows,
    ] = await Promise.all([
      db.select().from(users),
      db.select().from(teams),
      db.select().from(teamMembers),
      db.select().from(roles),
      db.select().from(roleAssignments),
      db.select().from(zoneGrants),
      // Token-hash is the only column that's never re-importable — it's
      // an Argon2 of the original opaque token, which the user only ever
      // sees at issue time. Including it in the export preserves the
      // ability to validate existing tokens on the restore side, so a
      // restore-from-backup doesn't invalidate every operator's token.
      db.select().from(apiTokens),
      db.select().from(settings),
      db.select().from(pdnsClusters),
      db.select().from(pdnsServers),
      db.select().from(oidcProviders),
      db.select().from(samlProviders),
      db.select().from(ldapProviders),
      db.select().from(authProviderSlugs),
      db.select().from(zoneTemplates),
      db.select().from(backendAdvisories),
      // Audit log: last 10000 rows. Operators wanting a full audit dump
      // for compliance archival should use `pg_dump`/SQLite `.dump` on
      // the raw table; this endpoint is for app-state DR, not forensic
      // retention.
      db.select().from(auditLog).limit(10_000),
    ]);

    const bundle = {
      meta: {
        schema_version: 1,
        app_version: APP_VERSION_LABEL,
        exported_at: new Date().toISOString(),
        exported_by_user_id: user.id,
        notes: [
          "This export contains app DB state only — no PDNS zone data.",
          "APP_SECRET_KEY and APP_ENCRYPTION_KEY are NOT included; they stay env-side.",
          "Encrypted columns are ciphertext — useless without APP_ENCRYPTION_KEY.",
          "Restore must run against an instance with the SAME APP_ENCRYPTION_KEY.",
          "See RESTORE.md (downloadable separately) for the operator runbook.",
        ],
      },
      tables: {
        users: usersRows,
        teams: teamsRows,
        team_members: teamMembersRows,
        roles: rolesRows,
        role_assignments: roleAssignmentsRows,
        zone_grants: zoneGrantsRows,
        api_tokens: apiTokensRows,
        settings: settingsRows,
        pdns_clusters: pdnsClustersRows,
        pdns_servers: pdnsServersRows,
        oidc_providers: oidcRows,
        saml_providers: samlRows,
        ldap_providers: ldapRows,
        auth_provider_slugs: authProviderSlugsRows,
        zone_templates: zoneTemplatesRows,
        backend_advisories: backendAdvisoriesRows,
        audit_log: auditLogRows,
      },
    };

    const hdrs = await headers();
    void appendAudit({
      actor: { type: "user", id: user.id },
      action: "system.backup.exported",
      resource: { type: "system", id: null },
      after: {
        // Row counts per table so audit search can spot anomalies
        // ("operator exported with empty users table?").
        rowCounts: Object.fromEntries(
          Object.entries(bundle.tables).map(([name, rows]) => [name, rows.length]),
        ),
      },
      request: getRequestContext(hdrs),
    });

    // Pretty-printed for diff-ability. The size cost (~2x vs minified)
    // is acceptable for a DR artifact; operators frequently want to
    // inspect a backup with `less` before restoring.
    const body = JSON.stringify(bundle, dateReplacer, 2);
    const filename = `pda-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err, "admin.backup.export.route.error");
  }
}

/**
 * `Date` instances → ISO strings. Drizzle returns timestamps as Date
 * objects; JSON.stringify would otherwise call their `.toJSON()`
 * (already ISO), which is fine — this replacer is belt-and-braces in
 * case any column type surprises us with a different Date variant.
 */
function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
