CREATE TABLE "backend_advisories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backend_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pdns_servers" DROP CONSTRAINT "pdns_servers_primary_id_pdns_servers_id_fk";
--> statement-breakpoint
DROP INDEX "pdns_servers_role_idx";--> statement-breakpoint
DROP INDEX "pdns_servers_primary_id_idx";--> statement-breakpoint
ALTER TABLE "pdns_servers" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "pdns_servers" ADD COLUMN "advertised_addresses" jsonb;--> statement-breakpoint
ALTER TABLE "backend_advisories" ADD CONSTRAINT "backend_advisories_backend_id_pdns_servers_id_fk" FOREIGN KEY ("backend_id") REFERENCES "public"."pdns_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backend_advisories_backend_code_idx" ON "backend_advisories" USING btree ("backend_id","code");--> statement-breakpoint
CREATE INDEX "backend_advisories_backend_idx" ON "backend_advisories" USING btree ("backend_id");--> statement-breakpoint
ALTER TABLE "pdns_servers" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "pdns_servers" DROP COLUMN "primary_id";--> statement-breakpoint
DROP TYPE "public"."pdns_server_role";