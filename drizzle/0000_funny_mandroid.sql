CREATE TYPE "public"."actor_type" AS ENUM('user', 'token', 'system');--> statement-breakpoint
CREATE TYPE "public"."pdns_cluster_write_strategy" AS ENUM('round_robin', 'lowest_latency', 'random', 'least_load');--> statement-breakpoint
CREATE TYPE "public"."pdns_server_role" AS ENUM('primary', 'secondary');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('global', 'team', 'zone', 'server');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"team_id" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" "inet",
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"user_agent" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "metric_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"zone_count" integer,
	"latency_p50_ms" double precision,
	"latency_p95_ms" double precision,
	"active_sessions" integer
);
--> statement-breakpoint
CREATE TABLE "oidc_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"issuer_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"scopes" text DEFAULT 'openid profile email' NOT NULL,
	"claim_email" text DEFAULT 'email' NOT NULL,
	"claim_name" text DEFAULT 'name' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"force_default" boolean DEFAULT false NOT NULL,
	"require_email_verified" boolean DEFAULT false NOT NULL,
	"discovery_cache" jsonb,
	"icon_url" text,
	"allowed_email_domains" jsonb,
	"group_mappings" jsonb,
	"claim_groups" text DEFAULT 'groups' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pdns_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"write_strategy" "pdns_cluster_write_strategy" DEFAULT 'round_robin' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdns_clusters_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "pdns_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	"server_id" uuid,
	"server_slug" text,
	"op" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"request_headers" jsonb,
	"request_body" jsonb,
	"response_status" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "pdns_server_stats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" bigint,
	"map_value" jsonb
);
--> statement-breakpoint
CREATE TABLE "pdns_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_url" text NOT NULL,
	"server_id" text DEFAULT 'localhost' NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"version_cache" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"role" "pdns_server_role" DEFAULT 'primary' NOT NULL,
	"primary_id" uuid,
	"cluster_id" uuid,
	"disabled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" uuid,
	"created_by" uuid,
	"provider_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"requires_mfa" boolean DEFAULT false NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"csrf_secret" text NOT NULL,
	"oidc_end_session_url" text,
	"oidc_id_token" text,
	"oidc_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_role" "team_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_user_id_team_id_pk" PRIMARY KEY("user_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"contact" text,
	"mail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image_url" text,
	"password_hash" text,
	"totp_secret_encrypted" text,
	"webauthn_credentials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email_verified_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_login_ip" "inet",
	"must_change_password" boolean DEFAULT false NOT NULL,
	"password_hash_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zone_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"zone_name" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zone_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"soa_ttl" integer DEFAULT 3600 NOT NULL,
	"soa_refresh" integer DEFAULT 3600 NOT NULL,
	"soa_retry" integer DEFAULT 900 NOT NULL,
	"soa_expire" integer DEFAULT 604800 NOT NULL,
	"soa_minimum" integer DEFAULT 3600 NOT NULL,
	"nameservers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text DEFAULT 'Native' NOT NULL,
	"soa_edit" text,
	"soa_edit_api" text,
	"api_rectify" boolean,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_for_primary_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD CONSTRAINT "oidc_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdns_clusters" ADD CONSTRAINT "pdns_clusters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdns_requests" ADD CONSTRAINT "pdns_requests_server_id_pdns_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."pdns_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdns_server_stats" ADD CONSTRAINT "pdns_server_stats_server_id_pdns_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."pdns_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdns_servers" ADD CONSTRAINT "pdns_servers_primary_id_pdns_servers_id_fk" FOREIGN KEY ("primary_id") REFERENCES "public"."pdns_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdns_servers" ADD CONSTRAINT "pdns_servers_cluster_id_pdns_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."pdns_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdns_servers" ADD CONSTRAINT "pdns_servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_provider_id_oidc_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."oidc_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_grants" ADD CONSTRAINT "zone_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_grants" ADD CONSTRAINT "zone_grants_server_id_pdns_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."pdns_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_grants" ADD CONSTRAINT "zone_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_templates" ADD CONSTRAINT "zone_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_prefix_idx" ON "api_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_tokens_team_idx" ON "api_tokens" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "metric_samples_server_time_idx" ON "metric_samples" USING btree ("server_id","sampled_at");--> statement-breakpoint
CREATE INDEX "metric_samples_time_idx" ON "metric_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_providers_slug_idx" ON "oidc_providers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pdns_requests_request_id_idx" ON "pdns_requests" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "pdns_requests_ts_idx" ON "pdns_requests" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "pdns_requests_server_id_idx" ON "pdns_requests" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "pdns_server_stats_server_ts_idx" ON "pdns_server_stats" USING btree ("server_id","ts");--> statement-breakpoint
CREATE INDEX "pdns_server_stats_server_name_ts_idx" ON "pdns_server_stats" USING btree ("server_id","name","ts");--> statement-breakpoint
CREATE INDEX "pdns_server_stats_ts_idx" ON "pdns_server_stats" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "pdns_servers_slug_idx" ON "pdns_servers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pdns_servers_default_idx" ON "pdns_servers" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "pdns_servers_disabled_idx" ON "pdns_servers" USING btree ("disabled_at");--> statement-breakpoint
CREATE INDEX "pdns_servers_role_idx" ON "pdns_servers" USING btree ("role");--> statement-breakpoint
CREATE INDEX "pdns_servers_primary_id_idx" ON "pdns_servers" USING btree ("primary_id");--> statement-breakpoint
CREATE INDEX "pdns_servers_cluster_id_idx" ON "pdns_servers" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "role_assignments_user_idx" ON "role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_assignments_role_idx" ON "role_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "role_assignments_scope_idx" ON "role_assignments" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "role_assignments_provider_idx" ON "role_assignments" USING btree ("provider_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_unique_idx" ON "role_assignments" USING btree ("user_id","role_id","scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_slug_idx" ON "roles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "roles_system_idx" ON "roles" USING btree ("is_system");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "team_members_team_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_slug_idx" ON "teams" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "teams_name_idx" ON "teams" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_disabled_idx" ON "users" USING btree ("disabled_at");--> statement-breakpoint
CREATE INDEX "zone_grants_user_idx" ON "zone_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "zone_grants_zone_idx" ON "zone_grants" USING btree ("server_id","zone_name");--> statement-breakpoint
CREATE UNIQUE INDEX "zone_grants_unique_idx" ON "zone_grants" USING btree ("user_id","server_id","zone_name");--> statement-breakpoint
CREATE UNIQUE INDEX "zone_templates_slug_idx" ON "zone_templates" USING btree ("slug");