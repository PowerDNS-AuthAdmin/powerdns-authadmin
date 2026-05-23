ALTER TABLE "pdns_servers" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
-- Backfill last_seen_at from the existing version-probe timestamp so an
-- upgraded fleet doesn't briefly show every backend as "never reached"
-- on the first dashboard load before the poller's first cycle runs.
UPDATE "pdns_servers" SET "last_seen_at" = ("version_cache"->>'fetchedAt')::timestamptz WHERE "version_cache" IS NOT NULL;