DROP INDEX "zone_grants_unique_idx";--> statement-breakpoint
ALTER TABLE "zone_grants" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "zone_grants" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "zone_grants" ADD CONSTRAINT "zone_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "zone_grants_team_idx" ON "zone_grants" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zone_grants_user_unique_idx" ON "zone_grants" USING btree ("user_id","server_id","zone_name") WHERE "zone_grants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "zone_grants_team_unique_idx" ON "zone_grants" USING btree ("team_id","server_id","zone_name") WHERE "zone_grants"."team_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "zone_grants" ADD CONSTRAINT "zone_grants_principal_check" CHECK (("zone_grants"."user_id" IS NULL) <> ("zone_grants"."team_id" IS NULL));