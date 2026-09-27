-- Turns, routine runs and facilitation run as workflows. A turn still owned by
-- a job has nothing left to run it, so it ends as failed, as an abandoned turn
-- does.
UPDATE "tool_call" SET "status" = 'failed', "approval_status" = CASE WHEN "approval_status" = 'pending' THEN 'denied' ELSE "approval_status" END, "error" = 'The turn stopped unexpectedly', "finished_at" = now() WHERE "status" IN ('running', 'awaiting_approval') AND "turn_id" IN (SELECT "turn"."id" FROM "turn" JOIN "job" ON "job"."id"::text = "turn"."owner" WHERE "job"."kind" = 'turn' AND "turn"."status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "message" SET "status" = 'failed' WHERE "turn_id" IN (SELECT "turn"."id" FROM "turn" JOIN "job" ON "job"."id"::text = "turn"."owner" WHERE "job"."kind" = 'turn' AND "turn"."status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "turn" SET "status" = 'failed', "error" = 'The turn stopped unexpectedly', "checkpoint" = NULL, "finished_at" = now(), "updated_at" = now() WHERE "id" IN (SELECT "turn"."id" FROM "turn" JOIN "job" ON "job"."id"::text = "turn"."owner" WHERE "job"."kind" = 'turn' AND "turn"."status" IN ('running', 'waiting'));--> statement-breakpoint
-- A routine run still queued has no workflow to start it.
UPDATE "routine_execution" SET "state" = 'cancelled', "error" = 'Cancelled by an upgrade before it started', "finished_at" = now() WHERE "state" = 'queued';--> statement-breakpoint
DROP TABLE "job";--> statement-breakpoint
DROP INDEX "routine_execution_dispatch_idx";--> statement-breakpoint
CREATE INDEX "routine_execution_list_idx" ON "routine_execution" ("routine_id","accepted_at","id");