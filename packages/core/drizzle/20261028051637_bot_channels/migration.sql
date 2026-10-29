CREATE UNIQUE INDEX "thread_bot_channel_idx" ON "thread" ("pod_id","host_agent_id") WHERE "type" = 'bot_channel';--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_type_valid", ADD CONSTRAINT "thread_type_valid" CHECK ("type" in ('conversation', 'pod_chat', 'bot_channel', 'collaboration', 'routine', 'routine_feed', 'system_agent'));--> statement-breakpoint
-- Each bot kept a thread of its own in a pod, which its branches hang off: the first becomes its channel.
UPDATE "thread" AS "conversation"
SET "type" = 'bot_channel', "title" = "agent"."name", "done_at" = NULL
FROM (
	SELECT DISTINCT ON ("pod_id", "host_agent_id") "id"
	FROM "thread"
	WHERE "type" = 'conversation' AND "host_agent_id" IS NOT NULL
		AND "conversation_id" = "id" AND "parent_thread_id" IS NULL
	ORDER BY "pod_id", "host_agent_id", "created_at", "id"
) AS "first", "agent"
WHERE "conversation"."id" = "first"."id"
	AND "agent"."id" = "conversation"."host_agent_id";
