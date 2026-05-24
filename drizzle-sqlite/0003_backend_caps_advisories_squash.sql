CREATE TABLE `backend_advisories` (
	`id` text PRIMARY KEY NOT NULL,
	`backend_id` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`acknowledged_at` integer,
	FOREIGN KEY (`backend_id`) REFERENCES `pdns_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backend_advisories_backend_code_idx` ON `backend_advisories` (`backend_id`,`code`);--> statement-breakpoint
CREATE INDEX `backend_advisories_backend_idx` ON `backend_advisories` (`backend_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pdns_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`base_url` text NOT NULL,
	`server_id` text DEFAULT 'localhost' NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`version_cache` text,
	`capabilities` text,
	`advertised_addresses` text,
	`last_seen_at` integer,
	`is_default` integer DEFAULT false NOT NULL,
	`cluster_id` text,
	`disabled_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `pdns_clusters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- MANUAL EDIT (release 1.1.0 squash): `capabilities` and `advertised_addresses` are
-- ADDED by this same squashed migration, so they do not exist on the source
-- `pdns_servers` at copy time. They are omitted from the copy and default to NULL for
-- existing rows (the backend poller repopulates them on first probe). Drizzle's
-- generated copy listed them on both sides; left as-is, SQLite's double-quoted-
-- identifier-as-string-literal fallback would have written the literal strings
-- 'capabilities' / 'advertised_addresses' into every migrated row. See ADR-0017.
INSERT INTO `__new_pdns_servers`("id", "slug", "name", "description", "base_url", "server_id", "api_key_encrypted", "version_cache", "last_seen_at", "is_default", "cluster_id", "disabled_at", "created_by", "created_at", "updated_at") SELECT "id", "slug", "name", "description", "base_url", "server_id", "api_key_encrypted", "version_cache", "last_seen_at", "is_default", "cluster_id", "disabled_at", "created_by", "created_at", "updated_at" FROM `pdns_servers`;--> statement-breakpoint
DROP TABLE `pdns_servers`;--> statement-breakpoint
ALTER TABLE `__new_pdns_servers` RENAME TO `pdns_servers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pdns_servers_slug_idx` ON `pdns_servers` (`slug`);--> statement-breakpoint
CREATE INDEX `pdns_servers_default_idx` ON `pdns_servers` (`is_default`);--> statement-breakpoint
CREATE INDEX `pdns_servers_disabled_idx` ON `pdns_servers` (`disabled_at`);--> statement-breakpoint
CREATE INDEX `pdns_servers_cluster_id_idx` ON `pdns_servers` (`cluster_id`);