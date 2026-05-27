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
CREATE UNIQUE INDEX `saml_providers_slug_idx` ON `saml_providers` (`slug`);