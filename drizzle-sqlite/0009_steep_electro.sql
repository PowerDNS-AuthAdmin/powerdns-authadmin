-- #85 — Session-scoped IdP-derived permissions (SQLite mirror of drizzle/0009).
-- See the PG migration for the rationale.

-- Wipe provider-derived rows from role_assignments BEFORE the table-recreate
-- dance below, otherwise the INSERT...SELECT would carry them over with
-- their provider_id stripped — preserving the grants while losing the
-- "this came from an IdP group" signal. Admin-issued rows
-- (`provider_id IS NULL`) are untouched.
DELETE FROM `role_assignments` WHERE `provider_id` IS NOT NULL;--> statement-breakpoint

-- SQLite table-recreate dance to drop the provider_id column.
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

-- Sessions get the new columns.
ALTER TABLE `sessions` ADD `derived_permissions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `oidc_refresh_token_encrypted` text;
