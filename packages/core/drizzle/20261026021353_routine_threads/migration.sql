ALTER TABLE "routine" ADD COLUMN "paused_after_failures_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_routine_feed_idx" ON "thread" ("routine_id");--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_routine_id_routine_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "routine"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_paused_after_failures_valid" CHECK ("paused_after_failures_at" is null or "state" = 'paused');--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_routine_valid" CHECK (("routine_id" is not null) = ("type" = 'routine_feed'));--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_type_valid", ADD CONSTRAINT "thread_type_valid" CHECK ("type" in ('conversation', 'pod_chat', 'collaboration', 'routine', 'routine_feed', 'system_agent'));--> statement-breakpoint
-- Each routine that has run gets its own thread, with its agent in it, and its runs move there from the bot's conversation, with the threads opened under them.
INSERT INTO "thread" ("workspace_id", "pod_id", "host_agent_id", "type", "title", "routine_id") SELECT "routine"."workspace_id", "agent"."pod_id", "routine"."agent_id", 'routine_feed', "routine"."name", "routine"."id" FROM "routine" INNER JOIN "agent" ON "agent"."id" = "routine"."agent_id" WHERE "agent"."pod_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "routine_execution" WHERE "routine_execution"."routine_id" = "routine"."id");--> statement-breakpoint
UPDATE "thread" SET "conversation_id" = "id" WHERE "type" = 'routine_feed';--> statement-breakpoint
INSERT INTO "thread_participant" ("thread_id", "agent_id") SELECT "id", "host_agent_id" FROM "thread" WHERE "type" = 'routine_feed';--> statement-breakpoint
WITH RECURSIVE "run_tree" ("id", "feed_id") AS (SELECT "routine_execution"."thread_id", "feed"."id" FROM "routine_execution" INNER JOIN "thread" AS "feed" ON "feed"."routine_id" = "routine_execution"."routine_id" UNION ALL SELECT "child"."id", "run_tree"."feed_id" FROM "thread" AS "child" INNER JOIN "run_tree" ON "child"."parent_thread_id" = "run_tree"."id" WHERE "child"."conversation_id" IS NOT NULL) UPDATE "thread" SET "conversation_id" = "run_tree"."feed_id" FROM "run_tree" WHERE "thread"."id" = "run_tree"."id";
