DROP INDEX "message_routine_execution_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_routine_execution_idx" ON "message" ("routine_execution_id","thread_id") WHERE "routine_execution_id" is not null;--> statement-breakpoint
-- A result already posted in a pod's chat was a copy of the one in the routine's thread, by
-- the same bot, with the same words, written moments after it: it becomes that run's result too.
UPDATE "message" AS "copy"
SET "routine_execution_id" = "result"."routine_execution_id"
FROM "message" AS "result", "thread" AS "chat"
WHERE "chat"."id" = "copy"."thread_id" AND "chat"."type" = 'pod_chat'
	AND "copy"."routine_execution_id" IS NULL
	AND "result"."routine_execution_id" IS NOT NULL
	AND "result"."author_agent_id" = "copy"."author_agent_id"
	AND "result"."content" = "copy"."content"
	AND "copy"."created_at" BETWEEN "result"."created_at" AND "result"."created_at" + interval '1 minute'
	AND NOT EXISTS (
		SELECT 1 FROM "message" AS "linked"
		WHERE "linked"."thread_id" = "copy"."thread_id"
			AND "linked"."routine_execution_id" = "result"."routine_execution_id"
	);
