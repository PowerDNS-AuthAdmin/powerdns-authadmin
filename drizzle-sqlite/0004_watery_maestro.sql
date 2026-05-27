-- Phase 1.5: per-provider `force_default` flag is retired. The default
-- sign-in method is now a single global setting (`auth_default_provider`)
-- edited from /admin/authentication. Translate any existing
-- force_default=true row into the new setting before dropping the column
-- so deployments that relied on the flag keep redirecting to the same IdP.
--
-- SQLite stores boolean as integer; force_default=1 means true. JSON values
-- in the settings table are stored as text — wrap the slug in quotes so it
-- parses as a JSON string.
INSERT OR IGNORE INTO settings (key, value, updated_by, updated_at)
SELECT
  'auth_default_provider',
  '"oidc:' || slug || '"',
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM oidc_providers
WHERE force_default = 1 AND enabled = 1
ORDER BY created_at DESC
LIMIT 1;
--> statement-breakpoint
ALTER TABLE `oidc_providers` DROP COLUMN `force_default`;
