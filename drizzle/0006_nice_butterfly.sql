CREATE TABLE "zone_horizons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid,
	"cluster_id" uuid,
	"zone_name" text NOT NULL,
	"horizon" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zone_horizons_scope_check" CHECK (("zone_horizons"."server_id" IS NULL) <> ("zone_horizons"."cluster_id" IS NULL)),
	CONSTRAINT "zone_horizons_horizon_check" CHECK ("zone_horizons"."horizon" IN ('public', 'internal'))
);
--> statement-breakpoint
ALTER TABLE "zone_horizons" ADD CONSTRAINT "zone_horizons_server_id_pdns_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."pdns_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_horizons" ADD CONSTRAINT "zone_horizons_cluster_id_pdns_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."pdns_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_horizons" ADD CONSTRAINT "zone_horizons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "zone_horizons_server_unique_idx" ON "zone_horizons" USING btree ("server_id","zone_name") WHERE "zone_horizons"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "zone_horizons_cluster_unique_idx" ON "zone_horizons" USING btree ("cluster_id","zone_name") WHERE "zone_horizons"."cluster_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "zone_horizons_zone_idx" ON "zone_horizons" USING btree ("zone_name");