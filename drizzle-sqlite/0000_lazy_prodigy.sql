CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`image_url` text,
	`password_hash` text,
	`totp_secret_encrypted` text,
	`webauthn_credentials` text DEFAULT '[]' NOT NULL,
	`email_verified_at` integer,
	`locked_until` integer,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`disabled_at` integer,
	`last_login_at` integer,
	`last_login_ip` text,
	`must_change_password` integer DEFAULT false NOT NULL,
	`password_hash_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_lower_idx` ON `users` (lower("email"));--> statement-breakpoint
CREATE INDEX `users_disabled_idx` ON `users` (`disabled_at`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`contact` text,
	`mail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_idx` ON `teams` (`slug`);--> statement-breakpoint
CREATE INDEX `teams_name_idx` ON `teams` (`name`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`team_role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `team_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_members_team_role_check" CHECK("team_members"."team_role" IN ('owner','member'))
);
--> statement-breakpoint
CREATE INDEX `team_members_team_idx` ON `team_members` (`team_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`csrf_secret` text NOT NULL,
	`oidc_end_session_url` text,
	`oidc_id_token` text,
	`oidc_client_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_system` integer DEFAULT false NOT NULL,
	`requires_mfa` integer DEFAULT false NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_slug_idx` ON `roles` (`slug`);--> statement-breakpoint
CREATE INDEX `roles_system_idx` ON `roles` (`is_system`);--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`created_by` text,
	`provider_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "role_assignments_scope_type_check" CHECK("role_assignments"."scope_type" IN ('global','team','zone','server'))
);
--> statement-breakpoint
CREATE INDEX `role_assignments_user_idx` ON `role_assignments` (`user_id`);--> statement-breakpoint
CREATE INDEX `role_assignments_role_idx` ON `role_assignments` (`role_id`);--> statement-breakpoint
CREATE INDEX `role_assignments_scope_idx` ON `role_assignments` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `role_assignments_provider_idx` ON `role_assignments` (`provider_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_assignments_unique_idx` ON `role_assignments` (`user_id`,`role_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`team_id` text,
	`expires_at` integer,
	`last_used_at` integer,
	`last_used_ip` text,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_prefix_idx` ON `api_tokens` (`prefix`);--> statement-breakpoint
CREATE INDEX `api_tokens_team_idx` ON `api_tokens` (`team_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`before` text,
	`after` text,
	`ip` text,
	`user_agent` text,
	`request_id` text,
	CONSTRAINT "audit_log_actor_type_check" CHECK("audit_log"."actor_type" IN ('user','token','system'))
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_log_resource_idx` ON `audit_log` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`);--> statement-breakpoint
CREATE TABLE `pdns_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`write_strategy` text DEFAULT 'round_robin' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pdns_clusters_write_strategy_check" CHECK("pdns_clusters"."write_strategy" IN ('round_robin','lowest_latency','random','least_load'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pdns_clusters_slug_unique` ON `pdns_clusters` (`slug`);--> statement-breakpoint
CREATE TABLE `pdns_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`base_url` text NOT NULL,
	`server_id` text DEFAULT 'localhost' NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`version_cache` text,
	`is_default` integer DEFAULT false NOT NULL,
	`role` text DEFAULT 'primary' NOT NULL,
	`primary_id` text,
	`cluster_id` text,
	`disabled_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`primary_id`) REFERENCES `pdns_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cluster_id`) REFERENCES `pdns_clusters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pdns_servers_role_check" CHECK("pdns_servers"."role" IN ('primary','secondary'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pdns_servers_slug_idx` ON `pdns_servers` (`slug`);--> statement-breakpoint
CREATE INDEX `pdns_servers_default_idx` ON `pdns_servers` (`is_default`);--> statement-breakpoint
CREATE INDEX `pdns_servers_disabled_idx` ON `pdns_servers` (`disabled_at`);--> statement-breakpoint
CREATE INDEX `pdns_servers_role_idx` ON `pdns_servers` (`role`);--> statement-breakpoint
CREATE INDEX `pdns_servers_primary_id_idx` ON `pdns_servers` (`primary_id`);--> statement-breakpoint
CREATE INDEX `pdns_servers_cluster_id_idx` ON `pdns_servers` (`cluster_id`);--> statement-breakpoint
CREATE TABLE `metric_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text,
	`sampled_at` integer NOT NULL,
	`zone_count` integer,
	`latency_p50_ms` real,
	`latency_p95_ms` real,
	`active_sessions` integer
);
--> statement-breakpoint
CREATE INDEX `metric_samples_server_time_idx` ON `metric_samples` (`server_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `metric_samples_time_idx` ON `metric_samples` (`sampled_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`issuer_url` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text NOT NULL,
	`scopes` text DEFAULT 'openid profile email' NOT NULL,
	`claim_email` text DEFAULT 'email' NOT NULL,
	`claim_name` text DEFAULT 'name' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`force_default` integer DEFAULT false NOT NULL,
	`require_email_verified` integer DEFAULT false NOT NULL,
	`discovery_cache` text,
	`icon_url` text,
	`allowed_email_domains` text,
	`group_mappings` text,
	`claim_groups` text DEFAULT 'groups' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_slug_idx` ON `oidc_providers` (`slug`);--> statement-breakpoint
CREATE TABLE `zone_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`soa_ttl` integer DEFAULT 3600 NOT NULL,
	`soa_refresh` integer DEFAULT 3600 NOT NULL,
	`soa_retry` integer DEFAULT 900 NOT NULL,
	`soa_expire` integer DEFAULT 604800 NOT NULL,
	`soa_minimum` integer DEFAULT 3600 NOT NULL,
	`nameservers` text DEFAULT '[]' NOT NULL,
	`records` text DEFAULT '[]' NOT NULL,
	`kind` text DEFAULT 'Native' NOT NULL,
	`soa_edit` text,
	`soa_edit_api` text,
	`api_rectify` integer,
	`metadata` text DEFAULT '{}' NOT NULL,
	`default_for_primary_ids` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zone_templates_slug_idx` ON `zone_templates` (`slug`);--> statement-breakpoint
CREATE TABLE `zone_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `pdns_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `zone_grants_user_idx` ON `zone_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `zone_grants_zone_idx` ON `zone_grants` (`server_id`,`zone_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `zone_grants_unique_idx` ON `zone_grants` (`user_id`,`server_id`,`zone_name`);--> statement-breakpoint
CREATE TABLE `pdns_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`request_id` text,
	`server_id` text,
	`server_slug` text,
	`op` text NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`request_headers` text,
	`request_body` text,
	`response_status` integer,
	`error` text,
	FOREIGN KEY (`server_id`) REFERENCES `pdns_servers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pdns_requests_request_id_idx` ON `pdns_requests` (`request_id`);--> statement-breakpoint
CREATE INDEX `pdns_requests_ts_idx` ON `pdns_requests` (`ts`);--> statement-breakpoint
CREATE INDEX `pdns_requests_server_id_idx` ON `pdns_requests` (`server_id`);--> statement-breakpoint
CREATE TABLE `pdns_server_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`value` integer,
	`map_value` text,
	FOREIGN KEY (`server_id`) REFERENCES `pdns_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pdns_server_stats_server_ts_idx` ON `pdns_server_stats` (`server_id`,`ts`);--> statement-breakpoint
CREATE INDEX `pdns_server_stats_server_name_ts_idx` ON `pdns_server_stats` (`server_id`,`name`,`ts`);--> statement-breakpoint
CREATE INDEX `pdns_server_stats_ts_idx` ON `pdns_server_stats` (`ts`);