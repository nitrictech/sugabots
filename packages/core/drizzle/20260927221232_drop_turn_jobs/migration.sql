-- Turns run only as workflows. A turn still owned by a job has nothing left
-- to run it, so it ends as failed, as an abandoned turn does.
UPDATE "tool_call" SET "status" = 'failed', "approval_status" = CASE WHEN "approval_status" = 'pending' THEN 'denied' ELSE "approval_status" END, "error" = 'The turn stopped unexpectedly', "finished_at" = now() WHERE "status" IN ('running', 'awaiting_approval') AND "turn_id" IN (SELECT "turn"."id" FROM "turn" JOIN "job" ON "job"."id"::text = "turn"."owner" WHERE "job"."kind" = 'turn' AND "turn"."status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "message" SET "status" = 'failed' WHERE "turn_id" IN (SELECT "turn"."id" FROM "turn" JOIN "job" ON "job"."id"::text = "turn"."owner" WHERE "job"."kind" = 'turn' AND "turn"."status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "turn" SET "status" = 'failed', "error" = 'The turn stopped unexpectedly', "checkpoint" = NULL, "finished_at" = now(), "updated_at" = now() WHERE "id" IN (SELECT "turn"."id" FROM "turn" JOIN "job" ON "job"."id"::text = "turn"."owner" WHERE "job"."kind" = 'turn' AND "turn"."status" IN ('running', 'waiting'));--> statement-breakpoint
-- Thread summaries already run as workflows; their old jobs never run.
DELETE FROM "job" WHERE "kind" IN ('turn', 'thread_summary');--> statement-breakpoint
ALTER TABLE "job" DROP COLUMN "deferred_payload";--> statement-breakpoint
DROP INDEX "job_queued_dedupe_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "job_queued_dedupe_idx" ON "job" ("dedupe_key") WHERE "status" = 'queued';