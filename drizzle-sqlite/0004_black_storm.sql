CREATE TABLE `saml_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`idp_entity_id` text NOT NULL,
	`idp_sso_url` text NOT NULL,
	`idp_slo_url` text,
	`idp_signing_cert` text NOT NULL,
	`sp_signing_key_encrypted` text NOT NULL,
	`sp_signing_cert` text NOT NULL,
	`sp_encryption_key_encrypted` text,
	`sp_encryption_cert` text,
	`require_signed_response` integer DEFAULT true NOT NULL,
	`require_encrypted_assertion` integer DEFAULT false NOT NULL,
	`signature_algorithm` text DEFAULT 'sha256' NOT NULL,
	`name_id_format` text DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' NOT NULL,
	`claim_email` text DEFAULT 'email' NOT NULL,
	`claim_name` text DEFAULT 'name' NOT NULL,
	`claim_groups` text DEFAULT 'groups' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`allowed_email_domains` text,
	`group_mappings` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_providers_slug_idx` ON `saml_providers` (`slug`);--> statement-breakpoint
CREATE TABLE `ldap_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`server_url` text NOT NULL,
	`start_tls` integer DEFAULT false NOT NULL,
	`bind_dn` text NOT NULL,
	`bind_password_encrypted` text NOT NULL,
	`user_search_base` text NOT NULL,
	`user_search_filter` text DEFAULT '(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))' NOT NULL,
	`group_search_base` text,
	`group_search_filter` text,
	`group_attr` text DEFAULT 'memberOf' NOT NULL,
	`claim_email` text DEFAULT 'mail' NOT NULL,
	`claim_name` text DEFAULT 'displayName' NOT NULL,
	`tls_ca_cert` text,
	`enabled` integer DEFAULT true NOT NULL,
	`allowed_email_domains` text,
	`group_mappings` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ldap_providers_slug_idx` ON `ldap_providers` (`slug`);--> statement-breakpoint
CREATE TABLE `auth_provider_slugs` (
	`slug` text PRIMARY KEY NOT NULL,
	`provider_type` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- #85: wipe provider-derived rows BEFORE the role_assignments table
-- recreate. Otherwise the INSERT...SELECT below would silently preserve
-- them with the provider_id column stripped, leaving stale grants that
-- look admin-issued.
DELETE FROM `role_assignments` WHERE `provider_id` IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_role_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "role_assignments_scope_type_check" CHECK("__new_role_assignments"."scope_type" IN ('global','team','zone','server'))
);
--> statement-breakpoint
INSERT INTO `__new_role_assignments`("id", "user_id", "role_id", "scope_type", "scope_id", "created_by", "created_at", "updated_at") SELECT "id", "user_id", "role_id", "scope_type", "scope_id", "created_by", "created_at", "updated_at" FROM `role_assignments`;--> statement-breakpoint
DROP TABLE `role_assignments`;--> statement-breakpoint
ALTER TABLE `__new_role_assignments` RENAME TO `role_assignments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `role_assignments_user_idx` ON `role_assignments` (`user_id`);--> statement-breakpoint
CREATE INDEX `role_assignments_role_idx` ON `role_assignments` (`role_id`);--> statement-breakpoint
CREATE INDEX `role_assignments_scope_idx` ON `role_assignments` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_assignments_unique_idx` ON `role_assignments` (`user_id`,`role_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `__new_zone_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`team_id` text,
	`server_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `pdns_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "zone_grants_principal_check" CHECK(("__new_zone_grants"."user_id" IS NULL) <> ("__new_zone_grants"."team_id" IS NULL))
);
--> statement-breakpoint
-- team_id didn't exist on the source `zone_grants` table; hand-edited
-- from drizzle-kit's emit, which assumed it did.
INSERT INTO `__new_zone_grants`("id", "user_id", "team_id", "server_id", "zone_name", "permissions", "created_by", "created_at", "updated_at") SELECT "id", "user_id", NULL, "server_id", "zone_name", "permissions", "created_by", "created_at", "updated_at" FROM `zone_grants`;--> statement-breakpoint
DROP TABLE `zone_grants`;--> statement-breakpoint
ALTER TABLE `__new_zone_grants` RENAME TO `zone_grants`;--> statement-breakpoint
CREATE INDEX `zone_grants_user_idx` ON `zone_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `zone_grants_team_idx` ON `zone_grants` (`team_id`);--> statement-breakpoint
CREATE INDEX `zone_grants_zone_idx` ON `zone_grants` (`server_id`,`zone_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `zone_grants_user_unique_idx` ON `zone_grants` (`user_id`,`server_id`,`zone_name`) WHERE "zone_grants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `zone_grants_team_unique_idx` ON `zone_grants` (`team_id`,`server_id`,`zone_name`) WHERE "zone_grants"."team_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `derived_permissions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `oidc_refresh_token_encrypted` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `idp_provider_type` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `idp_provider_slug` text;--> statement-breakpoint
ALTER TABLE `oidc_providers` DROP COLUMN `force_default`;--> statement-breakpoint

-- #74: rename `oidc.read` / `oidc.manage` permission strings inside existing
-- `roles.permissions` JSON arrays. SQLite stores JSON as text — do the
-- substitution at the string level (no jsonb_agg available). The replace is
-- scoped to the exact quoted tokens so adjacent permissions can't be mangled.
UPDATE `roles`
SET `permissions` = REPLACE(REPLACE(`permissions`, '"oidc.manage"', '"auth.manage"'), '"oidc.read"', '"auth.read"')
WHERE `permissions` LIKE '%"oidc.read"%' OR `permissions` LIKE '%"oidc.manage"%';