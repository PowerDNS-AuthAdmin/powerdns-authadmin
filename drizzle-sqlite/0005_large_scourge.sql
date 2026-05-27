CREATE TABLE `auth_provider_slugs` (
	`slug` text PRIMARY KEY NOT NULL,
	`provider_type` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Backfill existing OIDC providers so the global uniqueness invariant holds
-- on every install — including ones upgraded from a release that didn't have
-- the table. INSERT OR IGNORE guards re-runs.
INSERT OR IGNORE INTO `auth_provider_slugs` (`slug`, `provider_type`, `created_at`)
SELECT `slug`, 'oidc', `created_at` FROM `oidc_providers`;
