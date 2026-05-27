/**
 * lib/db/schema/index.ts
 *
 * Re-exports every table. The runtime export resolves to one of two parallel
 * schema sets depending on `DATABASE_URL`:
 *
 *  - Postgres mode: the pg-core tables in this directory (the canonical
 *    source).
 *  - SQLite mode: the structurally-equivalent sqlite-core tables in
 *    `lib/db/schema-sqlite/`.
 *
 * Type-wise, every export is annotated as its Postgres flavor — that's the
 * canonical shape the rest of the codebase types against. At runtime, when
 * SQLite is active, the underlying object is the sqlite-core table. The two
 * schemas keep matching JS-side row types (modulo `bigint` ↔ `number` for
 * autoincrement primary keys, which consumers stringify anyway), so the
 * type-lie is structurally safe.
 *
 * Why this shape: repositories import `users` etc. from here. Making the
 * import point dispatch at module load means repository code is dialect-
 * agnostic — `db.select().from(users)` builds the right SQL because both
 * `db` (from `../index.ts`) and `users` (from this file) come from the
 * same dialect.
 *
 * For dialect-specific raw SQL, see `../sql-dialect.ts`.
 */

import { dialect } from "../_dialect";

import * as pgUsers from "./users";
import * as pgTeams from "./teams";
import * as pgTeamMembers from "./team-members";
import * as pgSessions from "./sessions";
import * as pgRoles from "./roles";
import * as pgRoleAssignments from "./role-assignments";
import * as pgApiTokens from "./api-tokens";
import * as pgAuditLog from "./audit-log";
import * as pgPdnsServers from "./pdns-servers";
import * as pgPdnsClusters from "./pdns-clusters";
import * as pgMetricSamples from "./metric-samples";
import * as pgBackendAdvisories from "./backend-advisories";
import * as pgSettings from "./settings";
import * as pgOidcProviders from "./oidc-providers";
import * as pgSamlProviders from "./saml-providers";
import * as pgAuthProviderSlugs from "./auth-provider-slugs";
import * as pgZoneTemplates from "./zone-templates";
import * as pgZoneGrants from "./zone-grants";
import * as pgPdnsRequests from "./pdns-requests";
import * as pgPdnsServerStats from "./pdns-server-stats";

import * as sqliteUsers from "@/lib/db/schema-sqlite/users";
import * as sqliteTeams from "@/lib/db/schema-sqlite/teams";
import * as sqliteTeamMembers from "@/lib/db/schema-sqlite/team-members";
import * as sqliteSessions from "@/lib/db/schema-sqlite/sessions";
import * as sqliteRoles from "@/lib/db/schema-sqlite/roles";
import * as sqliteRoleAssignments from "@/lib/db/schema-sqlite/role-assignments";
import * as sqliteApiTokens from "@/lib/db/schema-sqlite/api-tokens";
import * as sqliteAuditLog from "@/lib/db/schema-sqlite/audit-log";
import * as sqlitePdnsServers from "@/lib/db/schema-sqlite/pdns-servers";
import * as sqlitePdnsClusters from "@/lib/db/schema-sqlite/pdns-clusters";
import * as sqliteMetricSamples from "@/lib/db/schema-sqlite/metric-samples";
import * as sqliteBackendAdvisories from "@/lib/db/schema-sqlite/backend-advisories";
import * as sqliteSettings from "@/lib/db/schema-sqlite/settings";
import * as sqliteOidcProviders from "@/lib/db/schema-sqlite/oidc-providers";
import * as sqliteSamlProviders from "@/lib/db/schema-sqlite/saml-providers";
import * as sqliteAuthProviderSlugs from "@/lib/db/schema-sqlite/auth-provider-slugs";
import * as sqliteZoneTemplates from "@/lib/db/schema-sqlite/zone-templates";
import * as sqliteZoneGrants from "@/lib/db/schema-sqlite/zone-grants";
import * as sqlitePdnsRequests from "@/lib/db/schema-sqlite/pdns-requests";
import * as sqlitePdnsServerStats from "@/lib/db/schema-sqlite/pdns-server-stats";

const useSqlite = dialect === "sqlite";

// Helper: pick one of the two namespaces at runtime, return PG types.
function pick<TPg, TSqlite>(pg: TPg, sqlite: TSqlite): TPg {
  return (useSqlite ? sqlite : pg) as unknown as TPg;
}

// --- users ---
export const users = pick(pgUsers.users, sqliteUsers.users);
export type User = pgUsers.User;
export type NewUser = pgUsers.NewUser;
export type WebauthnCredential = pgUsers.WebauthnCredential;

// --- teams ---
export const teams = pick(pgTeams.teams, sqliteTeams.teams);
export type Team = pgTeams.Team;
export type NewTeam = pgTeams.NewTeam;

// --- team_members ---
export const teamMembers = pick(pgTeamMembers.teamMembers, sqliteTeamMembers.teamMembers);
export const teamRoleEnum = pgTeamMembers.teamRoleEnum;
export type TeamMember = pgTeamMembers.TeamMember;
export type NewTeamMember = pgTeamMembers.NewTeamMember;

// --- sessions ---
export const sessions = pick(pgSessions.sessions, sqliteSessions.sessions);
export type Session = pgSessions.Session;
export type NewSession = pgSessions.NewSession;

// --- roles ---
export const roles = pick(pgRoles.roles, sqliteRoles.roles);
export type Role = pgRoles.Role;
export type NewRole = pgRoles.NewRole;

// --- role_assignments ---
export const roleAssignments = pick(
  pgRoleAssignments.roleAssignments,
  sqliteRoleAssignments.roleAssignments,
);
export const scopeTypeEnum = pgRoleAssignments.scopeTypeEnum;
export type RoleAssignment = pgRoleAssignments.RoleAssignment;
export type NewRoleAssignment = pgRoleAssignments.NewRoleAssignment;

// --- api_tokens ---
export const apiTokens = pick(pgApiTokens.apiTokens, sqliteApiTokens.apiTokens);
export type ApiToken = pgApiTokens.ApiToken;
export type NewApiToken = pgApiTokens.NewApiToken;

// --- audit_log ---
export const auditLog = pick(pgAuditLog.auditLog, sqliteAuditLog.auditLog);
export const actorTypeEnum = pgAuditLog.actorTypeEnum;
export type AuditEntry = pgAuditLog.AuditEntry;
export type NewAuditEntry = pgAuditLog.NewAuditEntry;

// --- pdns_servers ---
export const pdnsServers = pick(pgPdnsServers.pdnsServers, sqlitePdnsServers.pdnsServers);

// --- pdns_clusters ---
export const pdnsClusters = pick(pgPdnsClusters.pdnsClusters, sqlitePdnsClusters.pdnsClusters);
export const pdnsClusterWriteStrategyEnum = pgPdnsClusters.pdnsClusterWriteStrategyEnum;
export type PdnsCluster = pgPdnsClusters.PdnsCluster;
export type NewPdnsCluster = pgPdnsClusters.NewPdnsCluster;
export type PdnsClusterWriteStrategy = pgPdnsClusters.PdnsClusterWriteStrategy;
export type PdnsServer = pgPdnsServers.PdnsServer;
export type NewPdnsServer = pgPdnsServers.NewPdnsServer;
export type { PdnsVersionCache, PdnsDaemonCapabilities } from "@/lib/pdns/types";

// --- metric_samples ---
export const metricSamples = pick(pgMetricSamples.metricSamples, sqliteMetricSamples.metricSamples);
export type MetricSample = pgMetricSamples.MetricSample;
export type NewMetricSample = pgMetricSamples.NewMetricSample;

// --- backend_advisories ---
export const backendAdvisories = pick(
  pgBackendAdvisories.backendAdvisories,
  sqliteBackendAdvisories.backendAdvisories,
);
export type BackendAdvisory = pgBackendAdvisories.BackendAdvisory;
export type NewBackendAdvisory = pgBackendAdvisories.NewBackendAdvisory;

// --- settings ---
export const settings = pick(pgSettings.settings, sqliteSettings.settings);
export type Setting = pgSettings.Setting;
export type NewSetting = pgSettings.NewSetting;

// --- oidc_providers ---
export const oidcProviders = pick(pgOidcProviders.oidcProviders, sqliteOidcProviders.oidcProviders);
export type OidcProvider = pgOidcProviders.OidcProvider;
export type NewOidcProvider = pgOidcProviders.NewOidcProvider;
export type OidcGroupMapping = pgOidcProviders.OidcGroupMapping;

// --- saml_providers ---
export const samlProviders = pick(pgSamlProviders.samlProviders, sqliteSamlProviders.samlProviders);
export type SamlProvider = pgSamlProviders.SamlProvider;
export type NewSamlProvider = pgSamlProviders.NewSamlProvider;
export type SamlGroupMapping = pgSamlProviders.SamlGroupMapping;

// --- auth_provider_slugs (cross-type slug uniqueness) ---
export const authProviderSlugs = pick(
  pgAuthProviderSlugs.authProviderSlugs,
  sqliteAuthProviderSlugs.authProviderSlugs,
);
export type AuthProviderSlug = pgAuthProviderSlugs.AuthProviderSlug;
export type NewAuthProviderSlug = pgAuthProviderSlugs.NewAuthProviderSlug;

// --- zone_templates ---
export const zoneTemplates = pick(pgZoneTemplates.zoneTemplates, sqliteZoneTemplates.zoneTemplates);
export type TemplateRecord = pgZoneTemplates.TemplateRecord;
export type ZoneTemplate = pgZoneTemplates.ZoneTemplate;
export type NewZoneTemplate = pgZoneTemplates.NewZoneTemplate;

// --- zone_grants ---
export const zoneGrants = pick(pgZoneGrants.zoneGrants, sqliteZoneGrants.zoneGrants);
export type ZoneGrant = pgZoneGrants.ZoneGrant;
export type NewZoneGrant = pgZoneGrants.NewZoneGrant;

// --- pdns_requests ---
export const pdnsRequests = pick(pgPdnsRequests.pdnsRequests, sqlitePdnsRequests.pdnsRequests);
export type PdnsRequestRow = pgPdnsRequests.PdnsRequestRow;
export type NewPdnsRequestRow = pgPdnsRequests.NewPdnsRequestRow;

// --- pdns_server_stats ---
export const pdnsServerStats = pick(
  pgPdnsServerStats.pdnsServerStats,
  sqlitePdnsServerStats.pdnsServerStats,
);
export type PdnsServerStatRow = pgPdnsServerStats.PdnsServerStatRow;
export type NewPdnsServerStatRow = pgPdnsServerStats.NewPdnsServerStatRow;
