/**
 * lib/db/schema-sqlite/index.ts
 *
 * Re-exports every SQLite table so Drizzle Kit can find them when generating
 * migrations. Mirror of `../schema/index.ts`.
 */

export * from "./users";
export * from "./teams";
export * from "./team-members";
export * from "./sessions";
export * from "./roles";
export * from "./role-assignments";
export * from "./api-tokens";
export * from "./audit-log";
export * from "./pdns-clusters";
export * from "./pdns-servers";
export * from "./metric-samples";
export * from "./backend-advisories";
export * from "./settings";
export * from "./oidc-providers";
export * from "./saml-providers";
export * from "./ldap-providers";
export * from "./auth-provider-slugs";
export * from "./zone-templates";
export * from "./zone-grants";
export * from "./pdns-requests";
export * from "./pdns-server-stats";
