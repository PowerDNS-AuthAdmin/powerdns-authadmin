PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
-- Existing rows are user grants only (team_id didn't exist before); leave team_id NULL.
-- Hand-edited from drizzle-kit's output, which assumed team_id existed on the source table.
INSERT INTO `__new_zone_grants`("id", "user_id", "team_id", "server_id", "zone_name", "permissions", "created_by", "created_at", "updated_at") SELECT "id", "user_id", NULL, "server_id", "zone_name", "permissions", "created_by", "created_at", "updated_at" FROM `zone_grants`;--> statement-breakpoint
DROP TABLE `zone_grants`;--> statement-breakpoint
ALTER TABLE `__new_zone_grants` RENAME TO `zone_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `zone_grants_user_idx` ON `zone_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `zone_grants_team_idx` ON `zone_grants` (`team_id`);--> statement-breakpoint
CREATE INDEX `zone_grants_zone_idx` ON `zone_grants` (`server_id`,`zone_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `zone_grants_user_unique_idx` ON `zone_grants` (`user_id`,`server_id`,`zone_name`) WHERE "zone_grants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `zone_grants_team_unique_idx` ON `zone_grants` (`team_id`,`server_id`,`zone_name`) WHERE "zone_grants"."team_id" IS NOT NULL;