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
ALTER TABLE "ldap_providers" ADD CONSTRAINT "ldap_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ldap_providers_slug_idx" ON "ldap_providers" USING btree ("slug");