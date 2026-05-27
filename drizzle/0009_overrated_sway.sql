-- #85 — Session-scoped IdP-derived permissions.
--
-- After this migration:
--   - IdP-derived permissions live on `sessions.derived_permissions` (new
--     JSONB column), populated at sign-in by `computeGroupSync`.
--   - OIDC refresh tokens are stored encrypted on the session row so the
--     token-auth path can live-recompute groups at API token use time
--     (phase 2 of #85).
--   - `role_assignments.provider_id` is gone — provider-derived rows
--     have been deleted; future sign-ins materialise their permissions
--     into the session, not the user.
--
-- Affected users: anyone signed in via OIDC/SAML/LDAP. Their next
-- sign-in re-mints the derived permissions onto the new session column.
-- Existing active sessions keep their current admin-issued permissions
-- but lose IdP-derived perms until re-sign-in (documented in
-- UPGRADING.md).

-- Sessions get the new columns.
ALTER TABLE "sessions" ADD COLUMN "derived_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "oidc_refresh_token_encrypted" text;--> statement-breakpoint

-- Wipe provider-derived rows from role_assignments. They re-materialise
-- onto each user's next session at sign-in. Admin-issued rows
-- (`provider_id IS NULL`) are untouched.
DELETE FROM "role_assignments" WHERE "provider_id" IS NOT NULL;--> statement-breakpoint

-- Drop the provider_id FK + index + column. role_assignments now holds
-- admin-issued rows only.
ALTER TABLE "role_assignments" DROP CONSTRAINT "role_assignments_provider_id_oidc_providers_id_fk";--> statement-breakpoint
DROP INDEX "role_assignments_provider_idx";--> statement-breakpoint
ALTER TABLE "role_assignments" DROP COLUMN "provider_id";
