CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap" EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE (status IN ('holding','confirmed','checked_in'));
