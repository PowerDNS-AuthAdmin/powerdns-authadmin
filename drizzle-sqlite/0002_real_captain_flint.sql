ALTER TABLE `pdns_servers` ADD `last_seen_at` integer;--> statement-breakpoint
-- Backfill last_seen_at from the existing version-probe timestamp so an
-- upgraded fleet doesn't briefly show every backend as "never reached"
-- on the first dashboard load before the poller's first cycle runs.
UPDATE `pdns_servers` SET `last_seen_at` = CAST((julianday(json_extract(`version_cache`, '$.fetchedAt')) - 2440587.5) * 86400000 AS INTEGER) WHERE json_extract(`version_cache`, '$.fetchedAt') IS NOT NULL;