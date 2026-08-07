CREATE TABLE `zone_horizons` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`cluster_id` text,
	`zone_name` text NOT NULL,
	`horizon` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `pdns_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cluster_id`) REFERENCES `pdns_clusters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "zone_horizons_scope_check" CHECK(("zone_horizons"."server_id" IS NULL) <> ("zone_horizons"."cluster_id" IS NULL)),
	CONSTRAINT "zone_horizons_horizon_check" CHECK("zone_horizons"."horizon" IN ('public', 'internal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zone_horizons_server_unique_idx` ON `zone_horizons` (`server_id`,`zone_name`) WHERE "zone_horizons"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `zone_horizons_cluster_unique_idx` ON `zone_horizons` (`cluster_id`,`zone_name`) WHERE "zone_horizons"."cluster_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `zone_horizons_zone_idx` ON `zone_horizons` (`zone_name`);