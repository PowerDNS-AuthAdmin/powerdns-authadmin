-- Phase 1.5: per-provider `force_default` flag is retired. The default
-- sign-in method is now a single global setting (`auth_default_provider`)
-- edited from /admin/authentication. Translate any existing
-- force_default=true row into the new setting before dropping the column
-- so deployments that relied on the flag keep redirecting to the same IdP.
--
-- Tie-break mirrors the previous one: most recent enabled provider wins.
-- ON CONFLICT keeps an explicit operator-set value if there already is one
-- (e.g. set by a follow-up provisioning re-apply).
INSERT INTO settings (key, value, updated_by, updated_at)
SELECT
  'auth_default_provider',
  to_jsonb('oidc:' || slug),
  NULL,
  now()
FROM oidc_providers
WHERE force_default = true AND enabled = true
ORDER BY created_at DESC
LIMIT 1
ON CONFLICT (key) DO NOTHING;

ALTER TABLE "oidc_providers" DROP COLUMN "force_default";
