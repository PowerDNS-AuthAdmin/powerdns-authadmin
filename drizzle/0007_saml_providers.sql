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
ALTER TABLE "saml_providers" ADD CONSTRAINT "saml_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saml_providers_slug_idx" ON "saml_providers" USING btree ("slug");