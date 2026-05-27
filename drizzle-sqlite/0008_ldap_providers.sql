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
CREATE UNIQUE INDEX `ldap_providers_slug_idx` ON `ldap_providers` (`slug`);