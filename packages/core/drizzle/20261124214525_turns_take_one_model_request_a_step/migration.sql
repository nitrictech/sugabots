-- A turn takes one model request a step, and records which step made each of
-- its tool calls. Calls made before have none.
ALTER TABLE "tool_call" ADD COLUMN "step" integer;--> statement-breakpoint
-- A turn running or waiting now kept a checkpoint the bot loop can no longer
-- carry on from, so it ends as cancelled, as cancelling a turn ends it: its
-- unfinished tool calls fail, a pending approval is denied, and its reply
-- stops. Its workflow, once it resumes, finds the turn ended and frees its
-- lane; one waiting for approvals is told to stop by the sweep for lost
-- cancels, as the turn is marked as asked to stop.
UPDATE "tool_call" SET
	"status" = 'failed',
	"approval_status" = CASE WHEN "approval_status" = 'pending' THEN 'denied' ELSE "approval_status" END,
	"error" = 'Turn cancelled',
	"finished_at" = now()
WHERE "status" IN ('running', 'awaiting_approval')
	AND "turn_id" IN (SELECT "id" FROM "turn" WHERE "status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "message" SET "status" = 'cancelled'
WHERE "status" = 'writing'
	AND "turn_id" IN (SELECT "id" FROM "turn" WHERE "status" IN ('running', 'waiting'));--> statement-breakpoint
UPDATE "turn" SET
	"status" = 'cancelled',
	"interrupt_requested" = true,
	"checkpoint" = NULL,
	"finished_at" = now()
WHERE "status" IN ('running', 'waiting');--> statement-breakpoint
-- A failed turn waiting to run again starts from nothing, so its old
-- checkpoint goes too.
UPDATE "turn" SET "checkpoint" = NULL WHERE "checkpoint" IS NOT NULL;
