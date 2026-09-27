-- Routine runs are workflows started through a lane, so a run still queued
-- from before has nothing to start it.
UPDATE "routine_execution" SET "state" = 'cancelled', "error" = 'Cancelled by an upgrade before it started', "finished_at" = now() WHERE "state" = 'queued';--> statement-breakpoint
DROP TABLE "job";--> statement-breakpoint
DROP INDEX "routine_execution_dispatch_idx";--> statement-breakpoint
CREATE INDEX "routine_execution_list_idx" ON "routine_execution" ("routine_id","accepted_at","id");