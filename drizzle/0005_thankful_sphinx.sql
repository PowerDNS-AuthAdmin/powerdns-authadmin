CREATE TABLE "auth_provider_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backfill existing OIDC providers so the global uniqueness invariant holds
-- on every install — including ones upgraded from a release that didn't have
-- the table. ON CONFLICT shouldn't fire here (this migration creates the
-- table empty) but guards re-runs against a manual re-apply.
INSERT INTO "auth_provider_slugs" ("slug", "provider_type", "created_at")
SELECT "slug", 'oidc', "created_at" FROM "oidc_providers"
ON CONFLICT ("slug") DO NOTHING;
