CREATE TABLE "auth_provider_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ldap_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"server_url" text NOT NULL,
	"start_tls" boolean DEFAULT false NOT NULL,
	"bind_dn" text NOT NULL,
	"bind_password_encrypted" text NOT NULL,
	"user_search_base" text NOT NULL,
	"user_search_filter" text DEFAULT '(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))' NOT NULL,
	"group_search_base" text,
	"group_search_filter" text,
	"group_attr" text DEFAULT 'memberOf' NOT NULL,
	"claim_email" text DEFAULT 'mail' NOT NULL,
	"claim_name" text DEFAULT 'displayName' NOT NULL,
	"tls_ca_cert" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_email_domains" jsonb,
	"group_mappings" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"idp_entity_id" text NOT NULL,
	"idp_sso_url" text NOT NULL,
	"idp_slo_url" text,
	"idp_signing_cert" text NOT NULL,
	"sp_signing_key_encrypted" text NOT NULL,
	"sp_signing_cert" text NOT NULL,
	"sp_encryption_key_encrypted" text,
	"sp_encryption_cert" text,
	"require_signed_response" boolean DEFAULT true NOT NULL,
	"require_encrypted_assertion" boolean DEFAULT false NOT NULL,
	"signature_algorithm" text DEFAULT 'sha256' NOT NULL,
	"name_id_format" text DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' NOT NULL,
	"claim_email" text DEFAULT 'email' NOT NULL,
	"claim_name" text DEFAULT 'name' NOT NULL,
	"claim_groups" text DEFAULT 'groups' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_email_domains" jsonb,
	"group_mappings" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- #85: wipe provider-derived rows BEFORE dropping the column, so we don't
-- silently preserve stale grants with their provenance stripped. Affected
-- users re-materialise their permissions into the new
-- `sessions.derived_permissions` on next sign-in.
DELETE FROM "role_assignments" WHERE "provider_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "role_assignments" DROP CONSTRAINT "role_assignments_provider_id_oidc_providers_id_fk";
--> statement-breakpoint
DROP INDEX "role_assignments_provider_idx";--> statement-breakpoint
DROP INDEX "zone_grants_unique_idx";--> statement-breakpoint
ALTER TABLE "zone_grants" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "derived_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "oidc_refresh_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_provider_type" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_provider_slug" text;--> statement-breakpoint
ALTER TABLE "zone_grants" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "ldap_providers" ADD CONSTRAINT "ldap_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_providers" ADD CONSTRAINT "saml_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ldap_providers_slug_idx" ON "ldap_providers" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "saml_providers_slug_idx" ON "saml_providers" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "zone_grants" ADD CONSTRAINT "zone_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "zone_grants_team_idx" ON "zone_grants" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zone_grants_user_unique_idx" ON "zone_grants" USING btree ("user_id","server_id","zone_name") WHERE "zone_grants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "zone_grants_team_unique_idx" ON "zone_grants" USING btree ("team_id","server_id","zone_name") WHERE "zone_grants"."team_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "oidc_providers" DROP COLUMN "force_default";--> statement-breakpoint
ALTER TABLE "role_assignments" DROP COLUMN "provider_id";--> statement-breakpoint
ALTER TABLE "zone_grants" ADD CONSTRAINT "zone_grants_principal_check" CHECK (("zone_grants"."user_id" IS NULL) <> ("zone_grants"."team_id" IS NULL));--> statement-breakpoint

-- #74: rename `oidc.read` / `oidc.manage` permission strings inside existing
-- `roles.permissions` arrays to the protocol-neutral `auth.read` /
-- `auth.manage` form. Now that SAML + LDAP share the same admin surface,
-- the OIDC-prefixed names are misleading.
UPDATE "roles"
SET "permissions" = (
  SELECT jsonb_agg(
    CASE
      WHEN p = 'oidc.read'   THEN 'auth.read'
      WHEN p = 'oidc.manage' THEN 'auth.manage'
      ELSE p
    END
  )
  FROM jsonb_array_elements_text("permissions") p
)
WHERE "permissions" @> '["oidc.read"]'::jsonb OR "permissions" @> '["oidc.manage"]'::jsonb;